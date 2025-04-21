/**
 * Onestar SIP Caller - Content Script
 * 
 * Bắt sự kiện bôi đen số điện thoại và hiển thị menu gọi điện
 * Cập nhật dựa trên dự án SIP desktop
 */

// Trạng thái kết nối và đăng nhập
let isAuthenticated = false;
let callState = 'idle';
let callDuration = '';
let lastErrorCode = null;
let lastErrorReason = '';
let sipConfig = null;

// Hằng số
const CALL_STATES = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  RINGING: 'ringing',
  ANSWERED: 'answered',
  HANGUP: 'hangup'
};

// Element call-to-action được thêm vào DOM
let callToActionElement = null;

// Kiểm tra xem một chuỗi có phải là số điện thoại
function isPhoneNumber(text) {
  // Chuỗi cần có ít nhất 3 số liên tiếp
  // Có thể chấp nhận các ký tự +, -, (), khoảng trắng
  const phoneRegex = /(?:\+?\d{1,3}[-\s()]*)?\d{3,}(?:[-\s()]*\d{2,}){1,}/;
  return phoneRegex.test(text);
}

// Làm sạch số điện thoại
function cleanPhoneNumber(text) {
  return text.replace(/[^\d+]/g, '');
}

// Tạo và hiển thị nút gọi điện tại vị trí được chọn
function showCallButton(selectedText, x, y) {
  // Nếu chưa đăng nhập hoặc không phải số điện thoại, không hiện nút
  if (!isAuthenticated || !isPhoneNumber(selectedText)) {
    return;
  }
  
  // Nếu đang có cuộc gọi, không hiện nút
  if (callState !== CALL_STATES.IDLE) {
    return;
  }
  
  // Xóa nút cũ nếu đã tồn tại
  hideCallButton();
  
  // Tạo element mới
  callToActionElement = document.createElement('div');
  callToActionElement.className = 'onestar-sip-call-button';
  callToActionElement.innerHTML = `
    <button class="onestar-call-btn">
      <img src="${chrome.runtime.getURL('icons/icon16.png')}" alt="Call">
      Gọi ${selectedText} qua SIP
    </button>
  `;
  
  // Đặt vị trí
  callToActionElement.style.position = 'absolute';
  callToActionElement.style.left = `${x}px`;
  callToActionElement.style.top = `${y}px`;
  callToActionElement.style.zIndex = '9999';
  
  // Thêm vào DOM
  document.body.appendChild(callToActionElement);
  
  // Thêm sự kiện click
  const button = callToActionElement.querySelector('.onestar-call-btn');
  if (button) {
    button.addEventListener('click', () => {
      makeCall(selectedText);
      hideCallButton();
    });
  }
}

// Ẩn nút gọi điện
function hideCallButton() {
  if (callToActionElement && callToActionElement.parentNode) {
    callToActionElement.parentNode.removeChild(callToActionElement);
    callToActionElement = null;
  }
}

// Thực hiện cuộc gọi
function makeCall(phoneNumber) {
  if (!isAuthenticated) {
    alert('Vui lòng đăng nhập SIP để thực hiện cuộc gọi');
    return;
  }
  
  const cleanNumber = cleanPhoneNumber(phoneNumber);
  if (cleanNumber.length < 3) {
    alert('Số điện thoại không hợp lệ');
    return;
  }
  
  // Kiểm tra trạng thái cuộc gọi hiện tại
  if (callState !== CALL_STATES.IDLE) {
    alert('Đang có cuộc gọi đang diễn ra');
    return;
  }
  
  chrome.runtime.sendMessage({
    action: 'makeCall',
    phoneNumber: cleanNumber
  }, (response) => {
    if (response && !response.success && response.error) {
      alert(`Không thể thực hiện cuộc gọi: ${response.error}`);
    }
  });
}

// Xử lý sự kiện bôi đen text
document.addEventListener('mouseup', (event) => {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();
  
  if (selectedText && isPhoneNumber(selectedText)) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    // Hiển thị nút gọi điện phía trên text được chọn
    const x = rect.left + window.scrollX;
    const y = rect.top + window.scrollY - 40; // Điều chỉnh vị trí 
    
    showCallButton(selectedText, x, y);
  } else {
    hideCallButton();
  }
});

// Ẩn nút khi click ra ngoài
document.addEventListener('click', (event) => {
  if (callToActionElement && !callToActionElement.contains(event.target)) {
    hideCallButton();
  }
});

// Ẩn nút khi scroll
document.addEventListener('scroll', () => {
  hideCallButton();
});

// Lắng nghe cập nhật trạng thái từ background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'statusUpdate') {
    isAuthenticated = request.status.isAuthenticated;
    callState = request.status.callState;
    callDuration = request.status.callDuration || '';
    lastErrorCode = request.status.lastErrorCode;
    lastErrorReason = request.status.lastErrorReason;
    sipConfig = request.status.sipConfig;
    
    // Ẩn nút gọi nếu đang trong cuộc gọi
    if (callState !== CALL_STATES.IDLE) {
      hideCallButton();
    }
  }
  
  return false;
});

// Kiểm tra trạng thái đăng nhập khi script được tải
chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
  if (response) {
    isAuthenticated = response.isAuthenticated;
    callState = response.callState;
    callDuration = response.callDuration || '';
    lastErrorCode = response.lastErrorCode;
    lastErrorReason = response.lastErrorReason;
    sipConfig = response.sipConfig;
  }
});