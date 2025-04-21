/**
 * Onestar SIP Caller - Popup Script
 * 
 * Quản lý giao diện người dùng popup và tương tác với background script
 * Cập nhật dựa trên dự án SIP desktop
 */

// Trạng thái của popup
let isAuthenticated = false;
let callState = 'idle';
let callDuration = '';
let sipConfig = null;
let lastErrorCode = null;
let lastErrorReason = '';
let isLoading = false;

// Hằng số
const CALL_STATES = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HANGUP: 'hangup'
};

// DOM Elements
const loader = document.getElementById('loader');
const loginForm = document.getElementById('login-form');
const authenticatedSection = document.getElementById('authenticated');
const instructions = document.getElementById('instructions');
const loginError = document.getElementById('login-error');
const userDisplayName = document.getElementById('display-name');
const extensionDisplay = document.getElementById('extension');
const statusIdle = document.getElementById('status-idle');
const statusRinging = document.getElementById('status-ringing');
const statusAnswered = document.getElementById('status-answered');
const callDurationElement = document.getElementById('call-duration');

// Form elements
const authForm = document.getElementById('auth-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const phoneInput = document.getElementById('phone-number');
const callButton = document.getElementById('call-button');
const hangupButton = document.getElementById('hangup-button');
const hangupButton2 = document.getElementById('hangup-button-2');
const logoutButton = document.getElementById('logout-button');

// Khởi tạo khi popup được mở
document.addEventListener('DOMContentLoaded', async () => {
  showLoader(true);
  await checkAuthStatus();
  initEventListeners();
  showLoader(false);
});

// Kiểm tra trạng thái đăng nhập
async function checkAuthStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
    isAuthenticated = response.isAuthenticated;
    callState = response.callState;
    callDuration = response.callDuration || '';
    lastErrorCode = response.lastErrorCode;
    lastErrorReason = response.lastErrorReason;
    sipConfig = response.sipConfig;
    updateUI();
  } catch (error) {
    console.error('Lỗi khi kiểm tra trạng thái đăng nhập:', error);
    isAuthenticated = false;
    updateUI();
  }
}

// Đăng nhập
async function login(username, password) {
  try {
    showLoader(true);
    isLoading = true;
    loginError.textContent = '';
    
    const response = await chrome.runtime.sendMessage({
      action: 'login',
      username,
      password
    });
    
    if (response.success) {
      isAuthenticated = true;
      sipConfig = response.sipConfig;
      updateUI();
    } else {
      loginError.textContent = response.error || 'Đăng nhập thất bại';
    }
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    loginError.textContent = error.message || 'Đã xảy ra lỗi khi đăng nhập';
  } finally {
    showLoader(false);
    isLoading = false;
  }
}

// Đăng xuất
async function logout() {
  try {
    showLoader(true);
    await chrome.runtime.sendMessage({ action: 'logout' });
    isAuthenticated = false;
    sipConfig = null;
    callState = 'idle';
    callDuration = '';
    lastErrorCode = null;
    lastErrorReason = '';
    updateUI();
  } catch (error) {
    console.error('Lỗi đăng xuất:', error);
  } finally {
    showLoader(false);
  }
}

// Thực hiện cuộc gọi
async function makeCall(phoneNumber) {
  try {
    showLoader(true);
    
    if (!phoneNumber || phoneNumber.trim() === '') {
      alert('Vui lòng nhập số điện thoại');
      showLoader(false);
      return;
    }
    
    const response = await chrome.runtime.sendMessage({
      action: 'makeCall',
      phoneNumber
    });
    
    if (!response.success) {
      alert(response.error || 'Không thể thực hiện cuộc gọi');
    }
  } catch (error) {
    console.error('Lỗi khi gọi điện:', error);
    alert('Đã xảy ra lỗi khi thực hiện cuộc gọi');
  } finally {
    showLoader(false);
  }
}

// Kết thúc cuộc gọi
async function endCall() {
  try {
    showLoader(true);
    await chrome.runtime.sendMessage({ action: 'endCall' });
  } catch (error) {
    console.error('Lỗi khi kết thúc cuộc gọi:', error);
  } finally {
    showLoader(false);
  }
}

// Cập nhật giao diện dựa trên trạng thái hiện tại
function updateUI() {
  if (isAuthenticated) {
    loginForm.style.display = 'none';
    authenticatedSection.style.display = 'block';
    instructions.style.display = 'block';
    
    // Hiển thị thông tin người dùng
    if (sipConfig) {
      userDisplayName.textContent = sipConfig.displayName || 'Người dùng';
      extensionDisplay.textContent = sipConfig.extension || 'N/A';
    }
    
    // Cập nhật trạng thái cuộc gọi
    updateCallStatus();
  } else {
    loginForm.style.display = 'block';
    authenticatedSection.style.display = 'none';
    instructions.style.display = 'none';
  }
}

// Cập nhật UI dựa trên trạng thái cuộc gọi
function updateCallStatus() {
  // Hiển thị thời gian cuộc gọi nếu có
  if (callDuration && callState === CALL_STATES.ANSWERED) {
    callDurationElement.textContent = callDuration;
    callDurationElement.style.display = 'block';
  } else {
    callDurationElement.style.display = 'none';
  }
  
  switch (callState) {
    case CALL_STATES.IDLE:
      statusIdle.style.display = 'flex';
      statusRinging.style.display = 'none';
      statusAnswered.style.display = 'none';
      
      // Hiển thị lỗi cuộc gọi cuối nếu có
      if (lastErrorCode && lastErrorReason) {
        const errorElement = document.getElementById('call-error');
        if (errorElement) {
          errorElement.textContent = `Cuộc gọi cuối: ${lastErrorReason} (${lastErrorCode})`;
          errorElement.style.display = 'block';
          
          // Tự động ẩn sau 10 giây
          setTimeout(() => {
            errorElement.style.display = 'none';
          }, 10000);
          
          // Reset sau khi hiển thị
          lastErrorCode = null;
          lastErrorReason = '';
        }
      }
      break;
      
    case CALL_STATES.CONNECTING:
      statusIdle.style.display = 'none';
      statusRinging.style.display = 'flex';
      statusAnswered.style.display = 'none';
      
      // Thay đổi text khi đang kết nối
      const statusText = document.querySelector('#status-ringing span:not(.status-dot)');
      if (statusText) {
        statusText.textContent = 'Đang kết nối...';
      }
      break;
      
    case CALL_STATES.RINGING:
      statusIdle.style.display = 'none';
      statusRinging.style.display = 'flex';
      statusAnswered.style.display = 'none';
      
      // Thay đổi text khi đang đổ chuông
      const ringingText = document.querySelector('#status-ringing span:not(.status-dot)');
      if (ringingText) {
        ringingText.textContent = 'Đang gọi...';
      }
      break;
      
    case CALL_STATES.ANSWERED:
      statusIdle.style.display = 'none';
      statusRinging.style.display = 'none';
      statusAnswered.style.display = 'flex';
      break;
      
    default:
      statusIdle.style.display = 'flex';
      statusRinging.style.display = 'none';
      statusAnswered.style.display = 'none';
  }
}

// Đăng ký các event listeners
function initEventListeners() {
  // Form đăng nhập
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Tránh đăng nhập trùng lặp
    if (isLoading) return;
    
    const username = usernameInput.value;
    const password = passwordInput.value;
    await login(username, password);
  });
  
  // Nút gọi điện
  callButton.addEventListener('click', () => {
    const phoneNumber = phoneInput.value;
    makeCall(phoneNumber);
  });
  
  // Cho phép nhấn Enter để gọi
  phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const phoneNumber = phoneInput.value;
      makeCall(phoneNumber);
    }
  });
  
  // Nút kết thúc cuộc gọi
  hangupButton.addEventListener('click', endCall);
  hangupButton2.addEventListener('click', endCall);
  
  // Nút đăng xuất
  logoutButton.addEventListener('click', logout);
  
  // Lắng nghe cập nhật trạng thái từ background script
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'statusUpdate') {
      isAuthenticated = request.status.isAuthenticated;
      callState = request.status.callState;
      callDuration = request.status.callDuration || '';
      lastErrorCode = request.status.lastErrorCode;
      lastErrorReason = request.status.lastErrorReason;
      sipConfig = request.status.sipConfig;
      updateUI();
    }
  });
}

// Hiển thị hoặc ẩn loader
function showLoader(show) {
  loader.style.display = show ? 'flex' : 'none';
}

// Khởi tạo popup
checkAuthStatus();