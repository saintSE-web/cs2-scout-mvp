(() => {
  "use strict";

  const routeKey = `cs2-scout-auto-demo:${location.pathname}`;
  const watchDemoLabels = ["watch demo", "download demo", "смотреть демо", "скачать демо"];

  function candidate() {
    return [...document.querySelectorAll("button, a[role='button'], a")].find((element) => {
      const text = (element.innerText || element.textContent || "").trim().toLowerCase();
      return watchDemoLabels.some((label) => text.includes(label)) && !element.hasAttribute("disabled");
    });
  }

  function clickNativeDownload() {
    if (sessionStorage.getItem(routeKey)) return true;
    const button = candidate();
    if (!button) return false;
    sessionStorage.setItem(routeKey, "clicked");
    button.click();
    return true;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (clickNativeDownload() || attempts >= 40) clearInterval(timer);
  }, 750);
})();
