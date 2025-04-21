/**
 * Onestar SIP Caller - Background Script
 * 
 * Quản lý kết nối SIP và xử lý các yêu cầu cuộc gọi
 */

// Cấu hình SIP
let sipConfig = null;
let isAuthenticated = false;
let ua = null; // User Agent JsSIP
let activeSession = null;
let callState = 'idle'; // idle, ringing, answered, hangup
let remoteAudio = null; // Element audio cho cuộc gọi

// Các hằng số từ dự án gốc
const AUTH_URL = 'https://office.onestar.vn/auth';
const API_URL = 'https://office.onestar.vn/api';
const SIP_WS_URL = 'wss://sip.socket.onestar.vn/ws';
const SIP_SERVER_HOST = '103.27.238.195';
const CALL_STATES = {
  IDLE: 'idle',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HANGUP: 'hangup'
};

// Tải thư viện JsSIP từ CDN khi extension được khởi chạy
function loadJsSIP() {
  return new Promise((resolve, reject) => {
    if (window.JsSIP) {
      resolve(window.JsSIP);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jssip/3.10.1/jssip.min.js';
    script.onload = () => {
      resolve(window.JsSIP);
    };
    script.onerror = () => {
      reject(new Error('Không thể tải thư viện JsSIP'));
    };
    document.head.appendChild(script);
  });
}

// Thiết lập menu ngữ cảnh khi extension được cài đặt
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "callWithSIP",
    title: "Gọi số \"%s\" qua SIP",
    contexts: ["selection"]
  });
});

// Xử lý khi người dùng click vào menu ngữ cảnh
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "callWithSIP") {
    const phoneNumber = info.selectionText.trim();
    makeCall(phoneNumber);
  }
});

// Lắng nghe các message từ popup và content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch(request.action) {
    case 'login':
      login(request.username, request.password)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Đảm bảo sendResponse hoạt động với promise

    case 'makeCall':
      makeCall(request.phoneNumber)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'endCall':
      endCall()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
      
    case 'getStatus':
      sendResponse({
        isAuthenticated,
        callState,
        sipConfig: isAuthenticated ? {
          extension: sipConfig?.extension,
          displayName: sipConfig?.displayName
        } : null
      });
      return false;
      
    case 'logout':
      logout();
      sendResponse({ success: true });
      return false;
      
    default:
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
});

// Hàm đăng nhập
async function login(username, password) {
  try {
    // Kiểm tra tham số đầu vào
    if (!username.trim() || !password) {
      throw new Error('Tên đăng nhập và mật khẩu không được để trống');
    }

    // Gửi yêu cầu đăng nhập
    const response = await fetch(`${AUTH_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Đăng nhập thất bại');
    }

    const data = await response.json();
    
    if (!data.data || !data.data.token) {
      throw new Error('Dữ liệu đăng nhập không hợp lệ');
    }
    
    // Lưu thông tin đăng nhập vào storage
    const userData = data.data;
    await chrome.storage.local.set({
      USERNAME: userData.username || '',
      USERID: userData._id || '',
      SIPID: userData.sip || '',
      TOKEN: userData.token || '',
      RETOKEN: userData.refreshToken || '',
      PHONE: userData.phone || '',
      EMAIL: userData.email || '',
      FIRSTNAME: userData.firstname || '',
      LASTNAME: userData.lastname || '',
      ROLE: userData.role?.map(item => item.name) || ''
    });
    
    isAuthenticated = true;
    
    // Lấy cấu hình SIP
    await fetchSIPConfig();
    
    // Khởi tạo kết nối SIP nếu lấy cấu hình thành công
    if (sipConfig) {
      await initSIPConnection();
    }
    
    // Gửi thông báo về trạng thái đăng nhập
    broadcastStatus();
    
    return { 
      success: true, 
      userData: {
        username: userData.username,
        firstname: userData.firstname,
        lastname: userData.lastname
      }
    };
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    isAuthenticated = false;
    return { success: false, error: error.message };
  }
}

// Hàm lấy cấu hình SIP
async function fetchSIPConfig() {
  try {
    const { SIPID, TOKEN } = await chrome.storage.local.get(['SIPID', 'TOKEN']);
    
    if (!SIPID || !TOKEN) {
      throw new Error('Không có SIPID hoặc TOKEN');
    }
    
    const response = await fetch(`${AUTH_URL}/user/sip?_id=${SIPID}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Không thể lấy cấu hình SIP');
    }
    
    const data = await response.json();
    
    if (data && data.data && data.data.length > 0) {
      const { FIRSTNAME, LASTNAME } = await chrome.storage.local.get(['FIRSTNAME', 'LASTNAME']);
      
      // Tạo cấu hình SIP
      sipConfig = {
        extension: data.data[0]?.extension,
        password: data.data[0]?.password,
        sipServer: data.data[0]?.pbx?.host || SIP_SERVER_HOST,
        wsHost: data.data[0]?.pbx?.WsHost || SIP_WS_URL,
        displayName: `${FIRSTNAME} ${LASTNAME}`
      };
      
      // Kiểm tra tính đầy đủ của cấu hình
      if (!sipConfig.extension || !sipConfig.password || !sipConfig.sipServer || !sipConfig.wsHost) {
        throw new Error('Cấu hình SIP không đầy đủ');
      }
      
      console.log('Lấy cấu hình SIP thành công:', sipConfig.extension);
      
      // Lưu cấu hình vào storage
      await chrome.storage.local.set({ SIP_CONFIG: sipConfig });
      
      return true;
    } else {
      throw new Error('Không có dữ liệu SIP');
    }
  } catch (error) {
    console.error('Lỗi khi lấy cấu hình SIP:', error);
    return false;
  }
}

// Khởi tạo kết nối SIP với JsSIP
async function initSIPConnection() {
  try {
    // Tải thư viện JsSIP
    await loadJsSIP();
    
    // Kiểm tra xem JsSIP đã tải chưa
    if (!window.JsSIP) {
      throw new Error('Không thể tải thư viện JsSIP');
    }
    
    // Tạo đối tượng JsSIP.UA (User Agent)
    const socket = new window.JsSIP.WebSocketInterface(sipConfig.wsHost);
    
    const config = {
      sockets: [socket],
      uri: `sip:${sipConfig.extension}@${sipConfig.sipServer}`,
      password: sipConfig.password,
      display_name: sipConfig.displayName,
      register: true,
      register_expires: 300, // Đăng ký hết hạn sau 5 phút
      session_timers: false,
      user_agent: 'Onestar SIP Caller'
    };
    
    // Tạo đối tượng audio cho cuộc gọi
    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.autoplay = true;
    }
    
    // Khởi tạo User Agent
    ua = new window.JsSIP.UA(config);
    
    // Đăng ký các sự kiện
    ua.on('registered', () => {
      console.log('Đã đăng ký SIP thành công');
      callState = CALL_STATES.IDLE;
      broadcastStatus();
    });
    
    ua.on('unregistered', () => {
      console.log('Đã hủy đăng ký SIP');
    });
    
    ua.on('registrationFailed', (e) => {
      console.error('Đăng ký SIP thất bại:', e);
    });
    
    ua.on('newRTCSession', (data) => {
      const session = data.session;
      
      if (session.direction === 'incoming') {
        console.log('Có cuộc gọi đến từ:', session.remote_identity.uri.user);
        
        // Lưu phiên hiện tại
        activeSession = session;
        callState = CALL_STATES.RINGING;
        broadcastStatus();
        
        // Đăng ký các sự kiện cho phiên
        registerSessionEvents(session);
        
        // Tự động trả lời cuộc gọi đến (tuỳ chọn)
        // session.answer({
        //   mediaConstraints: { audio: true, video: false },
        //   pcConfig: { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] }
        // });
      }
    });
    
    // Bắt đầu kết nối
    ua.start();
    console.log('Đã khởi tạo kết nối SIP');
    
    return true;
  } catch (error) {
    console.error('Lỗi khi khởi tạo kết nối SIP:', error);
    return false;
  }
}

// Đăng ký các sự kiện cho phiên cuộc gọi
function registerSessionEvents(session) {
  session.on('progress', () => {
    console.log('Cuộc gọi đang kết nối...');
    callState = CALL_STATES.RINGING;
    broadcastStatus();
  });
  
  session.on('accepted', () => {
    console.log('Cuộc gọi được chấp nhận');
    callState = CALL_STATES.ANSWERED;
    broadcastStatus();
  });
  
  session.on('confirmed', () => {
    console.log('Cuộc gọi đã thiết lập');
    callState = CALL_STATES.ANSWERED;
    broadcastStatus();
  });
  
  session.on('ended', () => {
    console.log('Cuộc gọi kết thúc');
    activeSession = null;
    callState = CALL_STATES.IDLE;
    broadcastStatus();
  });
  
  session.on('failed', (data) => {
    console.error('Cuộc gọi thất bại:', data.cause);
    activeSession = null;
    callState = CALL_STATES.IDLE;
    broadcastStatus();
  });
  
  // Xử lý luồng media
  session.on('peerconnection', (e) => {
    console.log('Thiết lập kết nối ngang hàng');
    const peerconnection = e.peerconnection;
    
    peerconnection.ontrack = (trackEvent) => {
      const remoteStream = trackEvent.streams[0];
      
      if (remoteAudio) {
        remoteAudio.srcObject = remoteStream;
      }
    };
  });
}

// Hàm thực hiện cuộc gọi với JsSIP
async function makeCall(phoneNumber) {
  try {
    // Kiểm tra đã đăng nhập chưa
    if (!isAuthenticated || !sipConfig) {
      throw new Error('Vui lòng đăng nhập trước khi gọi');
    }
    
    // Clean up số điện thoại (loại bỏ các ký tự không phải số trừ dấu +)
    const cleanNumber = phoneNumber.replace(/[^\d+]/g, '');
    
    if (cleanNumber.length < 3) {
      throw new Error('Số điện thoại không hợp lệ');
    }
    
    // Kiểm tra trạng thái cuộc gọi hiện tại
    if (callState !== CALL_STATES.IDLE) {
      throw new Error('Đang có cuộc gọi đang diễn ra');
    }
    
    // Kiểm tra xem User Agent đã được khởi tạo chưa
    if (!ua) {
      await initSIPConnection();
      if (!ua) {
        throw new Error('Không thể khởi tạo kết nối SIP');
      }
    }
    
    // Kiểm tra trạng thái đăng ký
    if (!ua.isRegistered()) {
      throw new Error('Chưa đăng ký với máy chủ SIP');
    }
    
    // Thực hiện cuộc gọi
    const callOptions = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] }
        ]
      }
    };
    
    console.log(`Đang gọi điện tới số: ${cleanNumber}`);
    
    // Tạo địa chỉ SIP URI
    const sipUri = `sip:${cleanNumber}@${sipConfig.sipServer}`;
    
    // Bắt đầu cuộc gọi
    activeSession = ua.call(sipUri, callOptions);
    callState = CALL_STATES.RINGING;
    broadcastStatus();
    
    // Đăng ký các sự kiện
    registerSessionEvents(activeSession);
    
    return { success: true, phoneNumber: cleanNumber };
  } catch (error) {
    console.error('Lỗi khi thực hiện cuộc gọi:', error);
    callState = CALL_STATES.IDLE;
    broadcastStatus();
    return { success: false, error: error.message };
  }
}

// Hàm kết thúc cuộc gọi
async function endCall() {
  try {
    if (callState === CALL_STATES.IDLE || !activeSession) {
      return { success: true, message: 'Không có cuộc gọi đang diễn ra' };
    }
    
    // Kết thúc cuộc gọi
    if (activeSession.isEstablished()) {
      activeSession.terminate();
    } else {
      activeSession.cancel();
    }
    
    callState = CALL_STATES.HANGUP;
    
    // Cập nhật trạng thái
    setTimeout(() => {
      callState = CALL_STATES.IDLE;
      activeSession = null;
      broadcastStatus();
    }, 1000);
    
    broadcastStatus();
    return { success: true };
  } catch (error) {
    console.error('Lỗi khi kết thúc cuộc gọi:', error);
    callState = CALL_STATES.IDLE;
    activeSession = null;
    broadcastStatus();
    return { success: false, error: error.message };
  }
}

// Hàm đăng xuất
function logout() {
  // Hủy đăng ký SIP nếu đang kết nối
  if (ua && ua.isRegistered()) {
    ua.unregister();
    ua.stop();
  }
  
  isAuthenticated = false;
  sipConfig = null;
  callState = CALL_STATES.IDLE;
  activeSession = null;
  ua = null;
  
  // Xóa dữ liệu từ storage
  chrome.storage.local.clear();
  
  // Broadcast status
  broadcastStatus();
}

// Hàm gửi trạng thái đến tất cả các components
function broadcastStatus() {
  const status = {
    isAuthenticated,
    callState,
    sipConfig: isAuthenticated ? {
      extension: sipConfig?.extension,
      displayName: sipConfig?.displayName
    } : null
  };
  
  // Gửi đến tất cả các tabs
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'statusUpdate', status })
        .catch(err => console.log('Tab không sẵn sàng', err));
    });
  });
}

// Khôi phục trạng thái từ storage khi extension được khởi chạy
async function restoreState() {
  try {
    const data = await chrome.storage.local.get([
      'TOKEN', 'SIP_CONFIG'
    ]);
    
    if (data.TOKEN && data.SIP_CONFIG) {
      isAuthenticated = true;
      sipConfig = data.SIP_CONFIG;
      console.log('Đã khôi phục trạng thái đăng nhập');
      
      // Khởi tạo kết nối SIP nếu đã đăng nhập
      await initSIPConnection();
    }
  } catch (error) {
    console.error('Lỗi khi khôi phục trạng thái:', error);
  }
}

// Khởi tạo extension
restoreState();