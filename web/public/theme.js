// Runs before first paint so the saved theme never flashes. Absent a choice, the system setting applies.
(function () {
  try {
    var t = localStorage.getItem('eighty-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
