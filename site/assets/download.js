(() => {
  const downloadLink = document.querySelector("[data-download-link]");
  const downloadNote = document.querySelector("[data-download-note]");
  if (!(downloadLink instanceof HTMLAnchorElement) || !downloadNote) return;

  const sourceUrl = "https://github.com/rsingapuri/pi-vis#building";

  function showSourceBuild(reason) {
    downloadLink.href = sourceUrl;
    downloadLink.textContent = "Build from source";
    downloadLink.setAttribute("aria-label", "Build Pi-Vis from source");
    downloadNote.textContent = reason;
  }

  function setNote(note) {
    downloadNote.textContent = note;
  }

  function platformLooksLikeMac(platform, userAgent) {
    return /mac/i.test(platform) || /macintosh|mac os x/i.test(userAgent);
  }

  function isX86Architecture(architecture) {
    return /x86|x64|amd64|ia32/i.test(architecture);
  }

  function isArmArchitecture(architecture) {
    return /arm|aarch64/i.test(architecture);
  }

  const nav = window.navigator;
  const userAgentData = nav.userAgentData;
  const platform = userAgentData?.platform || nav.platform || "";
  const userAgent = nav.userAgent || "";

  if (!platformLooksLikeMac(platform, userAgent)) {
    showSourceBuild(
      "Pi-Vis needs a Pi install and currently ships a macOS Apple Silicon DMG. This device needs a source build.",
    );
    return;
  }

  if (typeof userAgentData?.getHighEntropyValues !== "function") {
    setNote("Apple Silicon macOS only · Needs a Pi install · Intel Macs need a source build");
    return;
  }

  userAgentData
    .getHighEntropyValues(["architecture"])
    .then(({ architecture }) => {
      if (isX86Architecture(architecture)) {
        showSourceBuild(
          "Intel Mac detected. Pi-Vis needs a Pi install and currently requires a source build on Intel Macs.",
        );
      } else if (isArmArchitecture(architecture)) {
        setNote("Apple Silicon Mac detected · Needs a Pi install · MIT licensed");
      } else {
        setNote("Apple Silicon macOS only · Needs a Pi install · Intel Macs need a source build");
      }
    })
    .catch(() => {
      setNote("Apple Silicon macOS only · Needs a Pi install · Intel Macs need a source build");
    });
})();
