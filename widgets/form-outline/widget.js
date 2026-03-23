(function () {
  function init() {
    var form = document.querySelector('#mainForm');
    if (!form) return;

    // All <a> tags scroll to the form instead of navigating
    document.querySelectorAll('a').forEach(function (btn) {
      btn.removeAttribute('href');
      btn.addEventListener('click', function () {
        form.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });

    // Show preloader on submit
    form.addEventListener('submit', function () {
      var preloader = document.querySelector('#preloader');
      if (preloader) preloader.style.display = 'block';
      var btn = document.querySelector('#submit-btn');
      if (btn) btn.disabled = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
