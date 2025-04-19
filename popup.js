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
    sip