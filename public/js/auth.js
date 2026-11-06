(function () {
  if (/login\.html/.test(location.pathname)) return;

  var KEY = 'iones_auth_v2';
  var valid = false;
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var data = JSON.parse(raw);
      if (data && typeof data.exp === 'number' && Date.now() < data.exp) {
        valid = true;
      } else {
        localStorage.removeItem(KEY);
      }
    }
  } catch (e) {
    localStorage.removeItem(KEY);
  }

  if (!valid) {
    try { sessionStorage.setItem('iones_redirect', location.href); } catch (e) {}
    location.replace('login.html');
    return;
  }

  // 로그아웃 버튼 삽입
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.createElement('button');
    btn.textContent = '로그아웃';
    btn.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
      'padding:6px 14px', 'background:#374151', 'color:#e5e7eb',
      'border:none', 'border-radius:8px', 'font-size:12px',
      'cursor:pointer', 'opacity:0.75'
    ].join(';');
    btn.onmouseover = function () { btn.style.opacity = '1'; };
    btn.onmouseout  = function () { btn.style.opacity = '0.75'; };
    btn.onclick = function () { ioneLogout(); };
    document.body.appendChild(btn);
  });
})();

function ioneLogout() {
  localStorage.removeItem('iones_auth_v2');
  location.replace('login.html');
}
