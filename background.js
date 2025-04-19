/**
 * Onestar SIP Caller - Background Script
 * 
 * Quản lý kết nối SIP và xử lý các yêu cầu cuộc gọi
 */

// Cấu hình SIP
let sipConfig = null;
let isAuthenticated = false;
let activeSession = null;
let callState = 'idle'; // idle, ringing, answered, hangup

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

// Hàm thực hiện cuộc gọi
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
    
    // Giả lập cuộc gọi (trong extension thực tế, sẽ tích hợp với JsSIP)
    callState = CALL_STATES.RINGING;
    broadcastStatus();
    
    console.log(`Đang gọi điện tới số: ${cleanNumber}`);
    
    // Mở tab mới để thực hiện cuộc gọi từ web app
    const encodedNumber = encodeURIComponent(cleanNumber);
    const callUrl = `https://office.onestar.vn/sip/call?number=${encodedNumber}`;
    
    chrome.tabs.create({ url: callUrl });
    
    // Giả lập kết thúc cuộc gọi sau thời gian
    setTimeout(() => {
      callState = CALL_STATES.IDLE;
      broadcastStatus();
    }, 3000);
    
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
    if (callState === CALL_STATES.IDLE) {
      return { success: true, message: 'Không có cuộc gọi đang diễn ra' };
    }
    
    // Kết thúc cuộc gọi
    callState = CALL_STATES.HANGUP;
    
    // Giả lập hoàn thành cuộc gọi
    setTimeout(() => {
      callState = CALL_STATES.IDLE;
      broadcastStatus();
    }, 1000);
    
    broadcastStatus();
    return { success: true };
  } catch (error) {
    console.error('Lỗi khi kết thúc cuộc gọi:', error);
    callState = CALL_STATES.IDLE;
    broadcastStatus();
    return { success: false, error: error.message };
  }
}

// Hàm đăng xuất
function logout() {
  isAuthenticated = false;
  sipConfig = null;
  callState = CALL_STATES.IDLE;
  
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
    }
  } catch (error) {
    console.error('Lỗi khi khôi phục trạng thái:', error);
  }
}

// Khởi tạo extension
restoreState();