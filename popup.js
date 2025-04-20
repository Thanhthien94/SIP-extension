/**
 * Onestar SIP Caller - Popup Script
 * 
 * Quản lý giao diện người dùng popup và tương tác với background script
 */

// Trạng thái của popup
let isAuthenticated = false;
let callState = 'idle';
let sipConfig = null;

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
  switch (callState) {
    case 'idle':
      statusIdle.style.display = 'flex';
      statusRinging.style.display = 'none';
      statusAnswered.style.display = 'none';
      break;
    case 'ringing':
      statusIdle.style.display = 'none';
      statusRinging.style.display = 'flex';
      statusAnswered.style.display = 'none';
      break;
    case 'answered':
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
    const username = usernameInput.value;
    const password = passwordInput.value;
    await login(username, password);
  });
  
  // Nút gọi điện
  callButton.addEventListener('click', () => {
    const phoneNumber = phoneInput.value;
    makeCall(phoneNumber);
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