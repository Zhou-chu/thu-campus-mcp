/* 极小的主题引导脚本：在首屏绘制前定好配色，避免深色模式闪白。
   模式：light | dark | auto（auto 按本地时间，06:00-18:00 浅色）。CSP 只允许同源脚本，所以放在独立文件里。 */
(function () {
  var LIGHT_FROM = 6;
  var LIGHT_TO = 18;
  function resolveAuto() {
    var hour = new Date().getHours();
    return hour >= LIGHT_FROM && hour < LIGHT_TO ? "light" : "dark";
  }
  try {
    var saved = window.localStorage.getItem("campus.theme");
    var mode = saved === "light" || saved === "dark" ? saved : "auto";
    document.documentElement.dataset.theme = mode === "auto" ? resolveAuto() : mode;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
