/* 간단한 클라이언트 비밀번호 게이트 */
(function () {
  const KEY = 'app_auth';
  const PWD = 'hansol2024';

  if (sessionStorage.getItem(KEY) === '1') return;

  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9999;background:#1e2a3a',
    'display:flex;align-items:center;justify-content:center',
  ].join(';');

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:40px 36px;width:320px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)">
      <div style="font-size:2rem;margin-bottom:8px">⚙️</div>
      <div style="font-weight:700;font-size:1.1rem;margin-bottom:4px">파트 단가 관리 시스템</div>
      <div style="font-size:.8rem;color:#6c757d;margin-bottom:24px">HANSOL IONES</div>
      <input id="auth-input" type="password" placeholder="비밀번호 입력"
        style="width:100%;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:1rem;outline:none;margin-bottom:8px">
      <div id="auth-error" style="color:#dc3545;font-size:.82rem;min-height:20px;margin-bottom:8px"></div>
      <button id="auth-btn"
        style="width:100%;padding:10px;background:#0d6efd;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer">
        로그인
      </button>
    </div>`;

  document.body.appendChild(overlay);

  function tryLogin() {
    const val = document.getElementById('auth-input').value;
    if (val === PWD) {
      sessionStorage.setItem(KEY, '1');
      overlay.remove();
    } else {
      document.getElementById('auth-error').textContent = '비밀번호가 틀렸습니다.';
      document.getElementById('auth-input').value = '';
      document.getElementById('auth-input').focus();
    }
  }

  document.getElementById('auth-btn').addEventListener('click', tryLogin);
  document.getElementById('auth-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLogin();
  });

  setTimeout(() => document.getElementById('auth-input').focus(), 100);
})();
