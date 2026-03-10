(function () {
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function getSecondsUntilMidnight() {
    var now = new Date();
    var midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return Math.floor((midnight - now) / 1000);
  }

  function tick() {
    var total = getSecondsUntilMidnight();
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;

    var elH = document.getElementById('cdw-hours');
    var elM = document.getElementById('cdw-minutes');
    var elS = document.getElementById('cdw-seconds');

    if (elH) elH.textContent = pad(hours);
    if (elM) elM.textContent = pad(minutes);
    if (elS) elS.textContent = pad(seconds);
  }

  tick();
  setInterval(tick, 1000);
})();
