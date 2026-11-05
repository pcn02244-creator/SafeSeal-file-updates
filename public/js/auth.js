(function () {
  if (/login\.html/.test(location.pathname) || location.pathname === '/' && location.search === '') return;
  if (!sessionStorage.getItem('iones_auth_v1')) {
    sessionStorage.setItem('iones_redirect', location.href);
    location.replace('login.html');
  }
})();
