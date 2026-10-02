// Runs before first paint so the saved theme never flashes. Absent a choice, the system setting applies.
(function () {
  try {
    var t = (localStorage.getItem('cu-theme') || localStorage.getItem('eighty-theme'));
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('cu-look') === 'jack') document.documentElement.setAttribute('data-look', 'jack');
  } catch (e) {}
})();
