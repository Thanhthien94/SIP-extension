/**
 * Onestar SIP Caller - Background Script
 * 
 * Quản lý kết nối SIP và xử lý các yêu cầu cuộc gọi
 * Cập nhật dựa trên dự án SIP desktop
 */

// Cấu hình SIP
let sipConfig = null;
let isAuthenticated = false;
let ua = null; // User Agent JsSIP
let activeSession = null;
let callState = 'idle'; // idle, connecting, ringing, answered, hangup
let callStartTime = null;
let callDuration = '';
let callDurationInterval = null;
let remoteAudio = null; // Element audio cho cuộc gọi
let lastErrorCode = null; // Mã SIP của lỗi cuối cùng
let lastErrorReason = ''; // Lý do lỗi cuối cùng

// Biến theo dõi trạng thái kết nối
let sipInitCount = 0;
let lastInitTime = 0;
let reconnectTimeout = null;

// Biến theo dõi các lần thử gọi
let callRetryCount = 0;
let callRetryTimeout = null;

// Cấu hình retry
const MAX_RECONNECT_ATTEMPTS = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // Exponential backoff (2s, 4s, 8s)
const CALL_RETRY_DELAYS = [1500, 3000, 5000]; // Thời gian thử lại cuộc gọi (ms)

// Các hằng số từ dự án gốc
const AUTH_URL = 'https://office.onestar.vn/auth';
const API_URL = 'https://office.onestar.vn/api';
const SIP_WS_URL = 'wss://sip.socket.onestar.vn/ws';
const SIP_SERVER_HOST = '103.27.238.195';
const CALL_STATES = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HANGUP: 'hangup'
};

// Ánh xạ mã SIP -> thông báo 
const SIP_CODE_MESSAGES = {
  100: 'Đang thử kết nối',
  180: 'Đang đổ chuông',
  183: 'Đang tiến hành',
  200: 'Thành công',
  400: 'Yêu cầu không hợp lệ',
  401: 'Cần xác thực',
  403: 'Bị từ chối',
  404: 'Không tìm thấy',
  408: 'Hết thời gian chờ',
  480: 'Tạm thời không liên lạc được',
  486: 'Máy bận',
  487: 'Cuộc gọi đã hủy',
  488: 'Không chấp nhận',
  500: 'Lỗi máy chủ',
  503: 'Dịch vụ không khả dụng',
  600: 'Bận ở mọi nơi',
  603: 'Từ chối'
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
        callDuration,
        lastErrorCode,
        lastErrorReason,
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
      if (!validateSIPConfig(sipConfig)) {
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

// Kiểm tra tính hợp lệ của cấu hình SIP
function validateSIPConfig(config) {
  if (!config) return false;
  
  // Kiểm tra các trường bắt buộc
  if (!config.extension || config.extension.trim() === '') {
    console.error('Thiếu extension trong cấu hình SIP');
    return false;
  }
  
  if (!config.password || config.password.trim() === '') {
    console.error('Thiếu password trong cấu hình SIP');
    return false;
  }
  
  if (!config.sipServer || config.sipServer.trim() === '') {
    console.error('Thiếu sipServer trong cấu hình SIP');
    return false;
  }
  
  if (!config.wsHost || config.wsHost.trim() === '') {
    console.error('Thiếu wsHost trong cấu hình SIP');
    return false;
  }
  
  // Kiểm tra định dạng của extension (thường là số)
  if (!/^\d+$/.test(config.extension)) {
    console.warn('Extension không phải định dạng số');
    // Không fail ở đây vì có thể có những trường hợp đặc biệt
  }
  
  // Kiểm tra định dạng wsHost
  if (!config.wsHost.startsWith('ws://') && !config.wsHost.startsWith('wss://')) {
    console.error('wsHost phải bắt đầu bằng ws:// hoặc wss://');
    return false;
  }
  
  return true;
}

// Khởi tạo kết nối SIP với JsSIP
async function initSIPConnection() {
  try {
    // Kiểm tra loop
    const now = Date.now();
    if (lastInitTime && now - lastInitTime < 2000) {
      console.log('Throttling SIP init calls - gọi quá nhanh');
      return false;
    }
    lastInitTime = now;
    
    // Đếm số lần khởi tạo để tránh loop vô hạn
    sipInitCount = (sipInitCount || 0) + 1;
    if (sipInitCount > MAX_RECONNECT_ATTEMPTS) {
      console.error('Phát hiện loop, dừng việc khởi tạo SIP');
      // Reset sau 10 giây
      setTimeout(() => {
        sipInitCount = 0;
      }, 10000);
      return false;
    }
    
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
      register_expires: 600, // Tăng thời gian hết hạn thành 10 phút
      session_timers: true,
      user_agent: 'Onestar SIP Caller',
      hack_ip_in_contact: true, // Giúp xử lý một số vấn đề NAT/firewall
      no_answer_timeout: 45 // 45 giây không trả lời sẽ tự hủy
    };
    
    // Tạo đối tượng audio cho cuộc gọi
    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.autoplay = true;
    }
    
    // Khởi tạo User Agent
    ua = new window.JsSIP.UA(config);
    
    // Đăng ký các sự kiện với xử lý lỗi tốt hơn
    ua.on('registered', () => {
      console.log('Đã đăng ký SIP thành công');
      callState = CALL_STATES.IDLE;
      // Reset counter khi đăng ký thành công
      sipInitCount = 0;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      broadcastStatus();
    });
    
    ua.on('unregistered', () => {
      console.log('Đã hủy đăng ký SIP');
    });
    
    ua.on('registrationFailed', (e) => {
      console.error('Đăng ký SIP thất bại:', e);
      
      // Tự động thử lại khi đăng ký thất bại
      if (sipInitCount <= MAX_RECONNECT_ATTEMPTS) {
        const delay = RETRY_DELAYS[sipInitCount - 1] || 5000;
        console.log(`Sẽ thử lại sau ${delay/1000}s (lần ${sipInitCount}/${MAX_RECONNECT_ATTEMPTS})`);
        
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        
        reconnectTimeout = setTimeout(() => {
          console.log('Đang thử kết nối lại...');
          initSIPConnection();
        }, delay);
      }
    });
    
    ua.on('connected', () => {
      console.log('WebSocket đã kết nối');
    });
    
    ua.on('disconnected', () => {
      console.log('WebSocket đã ngắt kết nối');
      
      // Thử kết nối lại khi bị ngắt
      if (sipInitCount <= MAX_RECONNECT_ATTEMPTS) {
        const delay = RETRY_DELAYS[sipInitCount - 1] || 5000;
        
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        
        reconnectTimeout = setTimeout(() => {
          console.log('Đang thử kết nối lại sau khi bị ngắt...');
          initSIPConnection();
        }, delay);
      }
    });
    
    // Xử lý cuộc gọi tới tốt hơn
    ua.on('newRTCSession', (data) => {
      const session = data.session;
      
      if (session.direction === 'incoming') {
        console.log('Có cuộc gọi đến từ:', session.remote_identity.uri.user);
        
        // Lưu phiên hiện tại
        activeSession = session;
        callState = CALL_STATES.RINGING;
        broadcastStatus();
        
        // Đăng ký các sự kiện cho phiên với cải tiến từ dự án desktop
        registerSessionEvents(session);
      }
    });
    
    // Bắt đầu kết nối
    ua.start();
    console.log('Đã khởi tạo kết nối SIP');
    
    return true;
  } catch (error) {
    console.error('Lỗi khi khởi tạo kết nối SIP:', error);
    
    // Thử lại sau lỗi nếu chưa vượt quá số lần tối đa
    if (sipInitCount <= MAX_RECONNECT_ATTEMPTS) {
      const delay = RETRY_DELAYS[sipInitCount - 1] || 5000;
      console.log(`Sẽ thử lại sau ${delay/1000}s (lần ${sipInitCount}/${MAX_RECONNECT_ATTEMPTS})`);
      
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      
      reconnectTimeout = setTimeout(() => {
        console.log('Đang thử kết nối lại sau lỗi...');
        initSIPConnection();
      }, delay);
    }
    
    return false;
  }
}

// Đăng ký các sự kiện cho phiên cuộc gọi với xử lý early media tốt hơn
function registerSessionEvents(session) {
  // Theo dõi xem đã thiết lập early media chưa
  let hasEarlyMedia = false;

  session.on('progress', (e) => {
    console.log('Cuộc gọi đang kết nối...');
    callState = CALL_STATES.RINGING;
    broadcastStatus();
    
    // Kiểm tra early media trong progress event
    try {
      if (e.originator === 'remote' && e.response) {
        const contentType = e.response.getHeader ? e.response.getHeader('Content-Type') : null;
        const hasBody = !!e.response.body;
        
        console.log('Progress response info:', {
          hasContentType: !!contentType,
          contentType,
          hasBody
        });
        
        // Nếu phản hồi chứa SDP, có thể là early media
        if ((contentType === 'application/sdp' || contentType?.includes('sdp')) && hasBody) {
          console.log('SDP được phát hiện trong progress event - có thể có early media');
          hasEarlyMedia = true;
        }
      }
    } catch (error) {
      console.error('Lỗi khi xử lý early media tiềm năng:', error);
    }
  });
  
  session.on('accepted', () => {
    console.log('Cuộc gọi được chấp nhận');
    callState = CALL_STATES.ANSWERED;
    broadcastStatus();
    
    // Bắt đầu đếm thời gian cuộc gọi
    callStartTime = new Date();
    if (callDurationInterval) {
      clearInterval(callDurationInterval);
    }
    
    callDurationInterval = setInterval(() => {
      const now = new Date();
      const durationSeconds = Math.floor((now - callStartTime) / 1000);
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      callDuration = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      broadcastStatus();
    }, 1000);
  });
  
  session.on('confirmed', () => {
    console.log('Cuộc gọi đã thiết lập');
    callState = CALL_STATES.ANSWERED;
    broadcastStatus();
  });
  
  session.on('ended', () => {
    console.log('Cuộc gọi kết thúc');
    cleanupCall();
  });
  
  session.on('failed', (data) => {
    console.error('Cuộc gọi thất bại:', data.cause);
    
    // Xác định mã SIP từ dữ liệu lỗi
    let sipCode = null;
    
    try {
      if (data.message && data.message.status_code) {
        sipCode = data.message.status_code;
      } else if (data.cause === 'CANCELED' || data.cause === 'Canceled') {
        sipCode = 487; // Request Terminated
      } else if (data.cause === 'NO_ANSWER') {
        sipCode = 408; // Request Timeout
      } else if (data.cause === 'BUSY') {
        sipCode = 486; // Busy Here
      }
      
      // Lưu lại mã SIP để hiển thị cho người dùng
      lastErrorCode = sipCode;
      lastErrorReason = getSIPCodeMessage(sipCode);
    } catch (error) {
      console.error('Lỗi khi xử lý mã SIP:', error);
    }
    
    cleanupCall();
  });
  
  // Xử lý luồng media với cải tiến từ dự án desktop
  session.on('peerconnection', (e) => {
    console.log('Thiết lập kết nối ngang hàng');
    const peerconnection = e.peerconnection;
    
    peerconnection.ontrack = (trackEvent) => {
      console.log('Track được thêm vào:', trackEvent.track.kind);
      
      if (trackEvent.track.kind === 'audio') {
        console.log('Audio track được thêm vào peerConnection');
        
        if (!remoteAudio) {
          remoteAudio = new Audio();
          remoteAudio.autoplay = true;
        }
        
        // Tạo stream mới từ track và thêm vào audio element
        try {
          const stream = new MediaStream();
          stream.addTrack(trackEvent.track);
          
          remoteAudio.srcObject = stream;
          
          // Xử lý vấn đề autoplay policy
          const playPromise = remoteAudio.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => {
              console.error('Lỗi khi phát audio:', error);
              
              // Đặt lắng nghe sự kiện click để thử phát lại
              const resumeAudio = () => {
                if (!remoteAudio) return;
                
                remoteAudio.play()
                  .then(() => console.log('Audio đã tiếp tục sau tương tác người dùng'))
                  .catch(e => console.error('Vẫn không phát được audio:', e));
              };
              
              document.addEventListener('click', resumeAudio, { once: true });
            });
          }
        } catch (error) {
          console.error('Lỗi khi thiết lập audio stream:', error);
        }
      }
    };
    
    // Theo dõi trạng thái ICE connection
    peerconnection.oniceconnectionstatechange = () => {
      console.log('Trạng thái kết nối ICE thay đổi:', peerconnection.iceConnectionState);
      
      // Xử lý các tình huống mất kết nối
      if (peerconnection.iceConnectionState === 'failed' || 
          peerconnection.iceConnectionState === 'disconnected') {
        console.warn('Kết nối ICE không thành công hoặc bị ngắt');
      }
    };
  });
}

// Hàm dọn dẹp sau cuộc gọi
function cleanupCall() {
  activeSession = null;
  callState = CALL_STATES.IDLE;
  
  if (callDurationInterval) {
    clearInterval(callDurationInterval);
    callDurationInterval = null;
  }
  
  callDuration = '';
  broadcastStatus();
}

// Hàm lấy message từ mã SIP
function getSIPCodeMessage(code) {
  return SIP_CODE_MESSAGES[code] || 'Lỗi không xác định';
}

// Hàm thực hiện cuộc gọi với retry và xử lý lỗi tốt hơn
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
    
    // Reset trạng thái retry
    callRetryCount = 0;
    
    // Thực hiện cuộc gọi với retry logic
    return await attemptCall(cleanNumber);
  } catch (error) {
    console.error('Lỗi khi thực hiện cuộc gọi:', error);
    callState = CALL_STATES.IDLE;
    broadcastStatus();
    return { success: false, error: error.message };
  }
}

// Hàm thực hiện cuộc gọi với retry
async function attemptCall(cleanNumber) {
  // Kiểm tra xem User Agent đã được khởi tạo chưa
  if (!ua) {
    console.log('User Agent chưa được khởi tạo, đang khởi tạo...');
    await initSIPConnection();
    
    // Đợi một chút để kết nối hoàn tất
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!ua) {
      throw new Error('Không thể khởi tạo kết nối SIP');
    }
  }
  
  // Kiểm tra trạng thái đăng ký
  if (!ua.isRegistered()) {
    console.log('UA chưa đăng ký, đang thử đăng ký lại...');
    
    // Thử đăng ký lại
    try {
      ua.register();
      
      // Đợi đăng ký hoàn tất (tối đa 5 giây)
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (ua.isRegistered()) {
          console.log('Đã đăng ký SIP thành công sau khi thử lại');
          break;
        }
      }
    } catch (registerError) {
      console.error('Lỗi khi đăng ký lại SIP:', registerError);
    }
    
    // Kiểm tra lại sau khi thử đăng ký
    if (!ua.isRegistered()) {
      // Nếu vẫn chưa đăng ký được, thử lần nữa sau một khoảng thời gian
      if (callRetryCount < CALL_RETRY_DELAYS.length) {
        const delay = CALL_RETRY_DELAYS[callRetryCount];
        callRetryCount++;
        
        console.log(`Chưa thể kết nối SIP, thử lại lần ${callRetryCount} sau ${delay/1000}s`);
        
        // Thông báo đang trong trạng thái đang kết nối
        callState = CALL_STATES.CONNECTING;
        broadcastStatus();
        
        // Lên lịch thử lại
        return new Promise((resolve) => {
          callRetryTimeout = setTimeout(() => {
            attemptCall(cleanNumber).then(resolve);
          }, delay);
        });
      } else {
        throw new Error('Không thể kết nối đến máy chủ SIP sau nhiều lần thử');
      }
    }
  }
  
  // Thực hiện cuộc gọi
  const callOptions = {
    mediaConstraints: { audio: true, video: false },
    pcConfig: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] }
      ]
    },
    // Cho phép early media và tự động trả lời khi có tiến trình
    earlyMedia: true,
    answerOnProgress: true
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
      cleanupCall();
    }, 1000);
    
    broadcastStatus();
    return { success: true };
  } catch (error) {
    console.error('Lỗi khi kết thúc cuộc gọi:', error);
    cleanupCall();
    return { success: false, error: error.message };
  }
}

// Hàm đăng xuất
function logout() {
  // Hủy bỏ các timeout đang chạy
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  if (callRetryTimeout) {
    clearTimeout(callRetryTimeout);
    callRetryTimeout = null;
  }
  
  // Hủy đăng ký SIP nếu đang kết nối
  if (ua && ua.isRegistered()) {
    ua.unregister();
    ua.stop();
  }
  
  isAuthenticated = false;
  sipConfig = null;
  callState = CALL_STATES.IDLE;
  activeSession = null;
  lastErrorCode = null;
  lastErrorReason = '';
  ua = null;
  sipInitCount = 0;
  
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
    callDuration,
    lastErrorCode,
    lastErrorReason,
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
      'TOKEN', 'SIP_CONFIG', 'USERNAME', 'FIRSTNAME', 'LASTNAME', 'SIPID'
    ]);
    
    if (data.TOKEN && data.SIP_CONFIG) {
      // Kiểm tra tính đầy đủ của cấu hình SIP
      const storedConfig = data.SIP_CONFIG;
      
      if (!validateSIPConfig(storedConfig)) {
        console.warn('Cấu hình SIP không đầy đủ, cần lấy lại');
        
        // Thử lấy lại cấu hình SIP nếu có SIPID
        if (data.SIPID && data.TOKEN) {
          const success = await fetchSIPConfig();
          if (success) {
            console.log('Đã khôi phục cấu hình SIP thành công');
            isAuthenticated = true;
            
            // Khởi tạo kết nối SIP với delay
            setTimeout(() => {
              initSIPConnection();
            }, 1500);
          } else {
            console.error('Không thể lấy cấu hình SIP');
          }
        }
      } else {
        isAuthenticated = true;
        sipConfig = storedConfig;
        console.log('Đã khôi phục trạng thái đăng nhập');
        
        // Khởi tạo kết nối SIP nếu đã đăng nhập
        setTimeout(() => {
          initSIPConnection();
        }, 1500);
      }
    }
  } catch (error) {
    console.error('Lỗi khi khôi phục trạng thái:', error);
  }
}

// Khởi tạo extension
restoreState();