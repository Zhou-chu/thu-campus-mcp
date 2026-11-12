/* 极小的主题引导脚本：在首屏绘制前定好配色，避免深色模式闪白。
   CSP 只允许同源脚本，所以放在独立文件里而不是内联。 */
(function () {
  try {
    var saved = window.localStorage.getItem("campus.theme");
    var dark =
      saved === "dark" ||
      (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();