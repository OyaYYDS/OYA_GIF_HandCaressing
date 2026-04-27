/*
 * 手部挤压 GIF 生成器
 * - 纯前端本地处理
 * - Canvas 合成帧
 * - gif.js 编码导出
 */

// =========================
// 全局可调参数（集中管理）
// =========================
const CONFIG = {
  // 合成画布实际尺寸（比手部模板更大，以容纳超出手部区域的用户图片）
  WIDTH: 520,
  HEIGHT: 520,
  // 手部模板的原始尺寸（锁定在画布左上角，不随 WIDTH/HEIGHT 变化）
  HAND_WIDTH: 454,
  HAND_HEIGHT: 400,
  OUTPUT_WIDTH: 112,
  OUTPUT_HEIGHT: 112,
  TOTAL_FRAMES: 9,

  // 导入图片尺寸：以最终 GIF 输出边长的百分比为目标（0.85 = 占 85%）
  // 你要改「导入图片整体大小」，改这里。例如 0.9 更大，0.7 更小。
  IMAGE_TARGET_OUTPUT_RATIO: 0.93,

  // 导入图片在合成画布（454×400）上的锚点坐标（绝对像素）
  // ANCHOR_X_RATIO=0.5 时 BASE_X 是图片水平中心；ANCHOR_Y_RATIO=1 时 BASE_Y 是图片底边
  // 要往右移：增大 BASE_X；要往下移：增大 BASE_Y
  BASE_X: 310,
  BASE_Y: 520,

  // 锚点：底边中心附近，模拟真实被按压时“脚跟”不乱跑
  ANCHOR_X_RATIO: 0.5,
  ANCHOR_Y_RATIO: 1,

  // 纵向压缩曲线（第 5 帧最明显）
  SCALE_Y: [1.0, 0.96, 0.92, 0.88, 0.84, 0.88, 0.92, 0.96, 1.0],

  // 宽度补偿曲线：高度越小，宽度适当增大
  WIDTH_COMPENSATE_FACTOR: 0.5,

  // GIF 关键参数
  DEFAULT_FILENAME: "squish.gif",
  GIF_WORKERS: 2,
  GIF_QUALITY: 8,

  // GIF 透明键色（仅编码时使用，不作为可见背景）
  TRANSPARENT_KEY: { r: 255, g: 0, b: 255, hex: 0xff00ff },

  // GIF 只有二值透明：低于阈值的半透明像素直接视为透明，可显著降低黑边
  ALPHA_CUTOFF: 80,

  // 帧间隔（ms）
  SPEED_MODES: {
    fast: {
      name: "快速",
      frames: [0, 2, 5, 7],
      baseDelay: 20,
      extraDelay: {}
    },
    normal: {
      name: "普通",
      frames: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      baseDelay: 30,
      extraDelay: {}
    },
    slow: {
      name: "慢速",
      frames: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      baseDelay: 90,
      // 慢速模式通过延长关键帧持续时间实现（不重复编码同帧）
      extraDelay: {
        0: 120,
        2: 120,
        4: 140,
        6: 120,
        8: 120
      }
    }
  }
};

// 由 SCALE_Y 自动推导 SCALE_X，便于后续统一调参
const SCALE_X = CONFIG.SCALE_Y.map((v) => 1 + (1 - v) * CONFIG.WIDTH_COMPENSATE_FACTOR);

const state = {
  templates: [],
  userImage: null,
  userImageURL: "",
  userName: "",
  baseDrawWidth: 0,
  baseDrawHeight: 0,
  speedMode: "normal",
  previewTimer: null,
  generatedBlob: null,
  generatedURL: ""
};

const el = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  speedMode: document.getElementById("speedMode"),
  generateBtn: document.getElementById("generateBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  progressBar: document.getElementById("progressBar"),
  statusText: document.getElementById("statusText"),
  previewCanvas: document.getElementById("previewCanvas"),
  resultGif: document.getElementById("resultGif"),
  resultHint: document.getElementById("resultHint")
};

const previewCtx = el.previewCanvas.getContext("2d", { alpha: true });

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`);
  console.error(error);
});

async function init() {
  checkGIFLibrary();
  await preloadTemplates();
  bindEvents();
  drawIdlePreview();
  setStatus("模板加载完成，请上传图片。");
}

function checkGIFLibrary() {
  if (typeof window.GIF !== "function") {
    throw new Error("未检测到 gif.js，请检查网络或脚本引用是否正常。");
  }
}

async function preloadTemplates() {
  const promises = [];
  for (let i = 1; i <= CONFIG.TOTAL_FRAMES; i += 1) {
    // 统一先转 blob URL，再作为本地对象资源加载，尽量避免画布被跨域污染。
    promises.push(loadLocalSafeImage(`hand/${i}.png`));
  }
  state.templates = await Promise.all(promises);
}

function bindEvents() {
  el.fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await handleUserFile(file);
  });

  el.speedMode.addEventListener("change", () => {
    state.speedMode = el.speedMode.value;
    restartPreview();
    setStatus(`已切换速度：${CONFIG.SPEED_MODES[state.speedMode].name}`);
  });

  el.generateBtn.addEventListener("click", async () => {
    await generateGIF();
  });

  el.downloadBtn.addEventListener("click", () => {
    downloadGIF();
  });

  // 拖拽上传
  ["dragenter", "dragover"].forEach((eventName) => {
    el.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    el.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.dropZone.classList.remove("drag-over");
    });
  });

  el.dropZone.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }
    await handleUserFile(file);
  });
}

async function handleUserFile(file) {
  if (!file.type.startsWith("image/")) {
    setStatus("上传失败：请选择图片文件。", true);
    return;
  }

  try {
    const img = await fileToImage(file);

    if (state.userImageURL) {
      URL.revokeObjectURL(state.userImageURL);
    }

    state.userImage = img;
    state.userImageURL = img.src;
    state.userName = file.name;
    // 根据 IMAGE_TARGET_OUTPUT_RATIO 计算图片在合成画布中的目标尺寸，
    // 使其在最终 GIF 输出中约占设定比例，不依赖原图分辨率。
    const _canvasToOutputScale = Math.min(
      CONFIG.OUTPUT_WIDTH / CONFIG.HAND_WIDTH,
      CONFIG.OUTPUT_HEIGHT / CONFIG.HAND_HEIGHT
    );
    const _targetOutputPx = Math.min(CONFIG.OUTPUT_WIDTH, CONFIG.OUTPUT_HEIGHT) * CONFIG.IMAGE_TARGET_OUTPUT_RATIO;
    const _targetCanvasPx = _targetOutputPx / _canvasToOutputScale;
    const _aspect = img.naturalWidth / img.naturalHeight;
    if (_aspect >= 1) {
      state.baseDrawWidth  = Math.max(1, _targetCanvasPx);
      state.baseDrawHeight = Math.max(1, _targetCanvasPx / _aspect);
    } else {
      state.baseDrawHeight = Math.max(1, _targetCanvasPx);
      state.baseDrawWidth  = Math.max(1, _targetCanvasPx * _aspect);
    }

    // 清空旧的导出结果，避免下载到历史 GIF
    clearGeneratedResult();

    restartPreview();
    setStatus(`已加载图片：${file.name}`);
  } catch (error) {
    setStatus(`图片读取失败：${error.message}`, true);
    console.error(error);
  }
}

function restartPreview() {
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }

  if (!state.userImage || state.templates.length !== CONFIG.TOTAL_FRAMES) {
    drawIdlePreview();
    return;
  }

  const sequence = getPlaybackSequence(state.speedMode);
  let ptr = 0;

  const step = () => {
    const frameIndex = sequence.frames[ptr];
    renderFrame(previewCtx, frameIndex, false);

    const delay = sequence.delays[ptr];
    ptr = (ptr + 1) % sequence.frames.length;
    state.previewTimer = setTimeout(step, delay);
  };

  step();
}

function getPlaybackSequence(mode, forGif = false) {
  // 预览与导出都调用这个函数，所以你在 SPEED_MODES 中改的帧序和延时会完全同步到 GIF。
  const conf = CONFIG.SPEED_MODES[mode] || CONFIG.SPEED_MODES.normal;
  const delays = conf.frames.map((frameIndex) => {
    const rawDelay = conf.baseDelay + (conf.extraDelay[frameIndex] || 0);
    if (!forGif) {
      return rawDelay;
    }
    // GIF 以 10ms（1 centisecond）为最小时间单位，量化后与预览速度保持一致。
    return Math.max(10, Math.round(rawDelay / 10) * 10);
  });
  return {
    frames: conf.frames,
    delays
  };
}

function renderFrame(ctx, templateIndex, forGif) {
  ctx.clearRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);

  if (!state.userImage) {
    return;
  }

  const scaleX = SCALE_X[templateIndex] || 1;
  const scaleY = CONFIG.SCALE_Y[templateIndex] || 1;

  // 图片最终绘制尺寸：基础尺寸 × 当前帧挤压比例。
  // 若你只想整体放大/缩小，请改 CONFIG.IMAGE_SCALE；
  // 若要改挤压强度，请改 CONFIG.SCALE_Y / WIDTH_COMPENSATE_FACTOR。
  const drawWidth = state.baseDrawWidth * scaleX;
  const drawHeight = state.baseDrawHeight * scaleY;

  // BASE_X/BASE_Y 直接是画布锚点坐标。
  // ANCHOR_X_RATIO=0.5：BASE_X 是图片水平中心；ANCHOR_Y_RATIO=1：BASE_Y 是图片底边。
  // 挤压时图片底边保持不动，宽度向两侧均衡扩张，不会超出右边缘。
  const drawX = CONFIG.BASE_X - drawWidth * CONFIG.ANCHOR_X_RATIO;
  const drawY = CONFIG.BASE_Y - drawHeight * CONFIG.ANCHOR_Y_RATIO;

  ctx.drawImage(state.userImage, drawX, drawY, drawWidth, drawHeight);

  const template = state.templates[templateIndex];
  if (template) {
    // 手部模板锁定在画布左上角，以原始尺寸（HAND_WIDTH×HAND_HEIGHT）绘制
    ctx.drawImage(template, 0, 0, CONFIG.HAND_WIDTH, CONFIG.HAND_HEIGHT);
  }
}

function drawContainToOutput(srcCanvas, outCtx) {
  outCtx.clearRect(0, 0, CONFIG.OUTPUT_WIDTH, CONFIG.OUTPUT_HEIGHT);

  const scale = Math.min(
    CONFIG.OUTPUT_WIDTH / CONFIG.WIDTH,
    CONFIG.OUTPUT_HEIGHT / CONFIG.HEIGHT
  );

  const drawWidth = CONFIG.WIDTH * scale;
  const drawHeight = CONFIG.HEIGHT * scale;
  const drawX = (CONFIG.OUTPUT_WIDTH - drawWidth) / 2;
  const drawY = (CONFIG.OUTPUT_HEIGHT - drawHeight) / 2;

  outCtx.drawImage(srcCanvas, 0, 0, CONFIG.WIDTH, CONFIG.HEIGHT, drawX, drawY, drawWidth, drawHeight);
}

function prepareTransparentPixelsForGif(ctx) {
  const { r: keyR, g: keyG, b: keyB } = CONFIG.TRANSPARENT_KEY;
  const img = ctx.getImageData(0, 0, CONFIG.OUTPUT_WIDTH, CONFIG.OUTPUT_HEIGHT);
  const data = img.data;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];

    // GIF 仅支持二值透明：较低 Alpha 直接抠为透明，避免边缘脏黑。
    if (a <= CONFIG.ALPHA_CUTOFF) {
      data[i] = keyR;
      data[i + 1] = keyG;
      data[i + 2] = keyB;
      data[i + 3] = 255;
      continue;
    }

    // 对保留像素做白色预混合，去掉透明边缘里潜在的深色底，减少黑边。
    const alpha = a / 255;
    data[i] = Math.round(data[i] * alpha + 255 * (1 - alpha));
    data[i + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
    data[i + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
    data[i + 3] = 255;

    // 防止内容像素与键色撞色被误判透明。
    if (data[i] === keyR && data[i + 1] === keyG && data[i + 2] === keyB) {
      data[i] = 254;
      data[i + 1] = 0;
      data[i + 2] = 254;
    }
  }

  ctx.putImageData(img, 0, 0);
}

async function generateGIF() {
  if (!state.userImage) {
    setStatus("请先上传图片，再生成 GIF。", true);
    return;
  }

  if (typeof window.GIF !== "function") {
    setStatus("gif.js 未加载成功，无法生成。", true);
    return;
  }

  try {
    el.generateBtn.disabled = true;
    el.downloadBtn.disabled = true;
    el.progressBar.value = 0;
    setStatus("正在编码 GIF，请稍候...");

    // 生成时直接读取当前选择值，避免状态不同步。
    const activeMode = el.speedMode.value || state.speedMode;
    state.speedMode = activeMode;
    const sequence = getPlaybackSequence(activeMode, true);
    const composeCanvas = document.createElement("canvas");
    composeCanvas.width = CONFIG.WIDTH;
    composeCanvas.height = CONFIG.HEIGHT;
    const composeCtx = composeCanvas.getContext("2d", { alpha: true });

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = CONFIG.OUTPUT_WIDTH;
    outputCanvas.height = CONFIG.OUTPUT_HEIGHT;
    const outputCtx = outputCanvas.getContext("2d", { alpha: true });

    // 先渲染并做一次像素读取检测，提前发现污染问题并给出可执行提示。
    renderFrame(composeCtx, sequence.frames[0], true);
    assertCanvasReadable(composeCtx, "合成画布");
    drawContainToOutput(composeCanvas, outputCtx);
    assertCanvasReadable(outputCtx, "输出画布");

    const gif = new window.GIF({
      workers: CONFIG.GIF_WORKERS,
      quality: CONFIG.GIF_QUALITY,
      width: CONFIG.OUTPUT_WIDTH,
      height: CONFIG.OUTPUT_HEIGHT,
      repeat: 0,
      transparent: CONFIG.TRANSPARENT_KEY.hex,
      background: "#ff00ff",
      workerScript: "gif.worker.js"
    });

    for (let i = 0; i < sequence.frames.length; i += 1) {
      const frameIndex = sequence.frames[i];
      const delay = sequence.delays[i];
      renderFrame(composeCtx, frameIndex, true);
      drawContainToOutput(composeCanvas, outputCtx);
      prepareTransparentPixelsForGif(outputCtx);

      gif.addFrame(outputCanvas, {
        copy: true,
        delay,
        dispose: 2
      });
    }

    gif.on("progress", (p) => {
      const percent = Math.max(0, Math.min(100, Math.round(p * 100)));
      el.progressBar.value = percent;
      setStatus(`编码中：${percent}%`);
    });

    const blob = await new Promise((resolve, reject) => {
      gif.on("finished", (result) => resolve(result));
      gif.on("abort", () => reject(new Error("编码被中断。")));

      try {
        gif.render();
      } catch (err) {
        reject(err);
      }
    });

    updateGeneratedResult(blob);
    el.progressBar.value = 100;
    setStatus("GIF 生成完成（透明背景），可下载。");
  } catch (error) {
    setStatus(`生成失败：${error.message}`, true);
    console.error(error);
  } finally {
    el.generateBtn.disabled = false;
  }
}

function updateGeneratedResult(blob) {
  if (state.generatedURL) {
    URL.revokeObjectURL(state.generatedURL);
  }

  state.generatedBlob = blob;
  state.generatedURL = URL.createObjectURL(blob);
  el.resultGif.src = state.generatedURL;
  el.resultGif.style.display = "block";
  el.resultHint.style.display = "none";
  el.downloadBtn.disabled = false;
}

function clearGeneratedResult() {
  state.generatedBlob = null;
  if (state.generatedURL) {
    URL.revokeObjectURL(state.generatedURL);
    state.generatedURL = "";
  }
  el.resultGif.removeAttribute("src");
  el.resultGif.style.display = "none";
  el.resultHint.style.display = "block";
  el.downloadBtn.disabled = true;
}

function downloadGIF() {
  if (!state.generatedBlob || !state.generatedURL) {
    setStatus("请先生成 GIF，再下载。", true);
    return;
  }

  const a = document.createElement("a");
  a.href = state.generatedURL;
  a.download = CONFIG.DEFAULT_FILENAME;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setStatus(`已开始下载：${CONFIG.DEFAULT_FILENAME}`);
}

function drawIdlePreview() {
  previewCtx.clearRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);
  previewCtx.fillStyle = "rgba(72, 61, 50, 0.75)";
  previewCtx.font = "16px 'Noto Sans SC', sans-serif";
  previewCtx.textAlign = "center";
  previewCtx.textBaseline = "middle";
  previewCtx.fillText("上传图片后将自动开始预览", CONFIG.WIDTH / 2, CONFIG.HEIGHT / 2);
}

function setStatus(text, isError = false) {
  el.statusText.textContent = text;
  el.statusText.style.color = isError ? "#a13622" : "#5f5244";
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 对网络资源启用匿名跨域，避免后续 Canvas 读像素时报 taint。
    if (/^https?:\/\//i.test(src)) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`模板加载失败：${src}`));
    img.src = src;
  });
}

function requestBlobByXHR(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path, true);
    xhr.responseType = "blob";
    xhr.onload = () => {
      // file:// 下可能是 0；http(s) 通常是 200。
      if (xhr.status === 200 || xhr.status === 0) {
        resolve(xhr.response);
        return;
      }
      reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("XHR 读取失败"));
    xhr.send();
  });
}

async function loadLocalSafeImage(path) {
  let objectURL = "";
  try {
    // 1) 优先 XHR 读取，兼容更多 file:// 场景。
    const blob = await requestBlobByXHR(path);
    objectURL = URL.createObjectURL(blob);
    return await loadImage(objectURL);
  } catch (_xhrError) {
    try {
      // 2) 回退 fetch 读取。
      const res = await fetch(path, { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      objectURL = URL.createObjectURL(blob);
      return await loadImage(objectURL);
    } catch (_fetchError) {
      // 3) 最后回退直接加载，若失败会在外层被捕获。
      return loadImage(path);
    }
  } finally {
    // objectURL 在图片像素完成解码后可立即释放，不影响已解码结果。
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
    }
  }
}

function assertCanvasReadable(ctx, label) {
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (_error) {
    throw new Error(
      `${label}被跨域数据污染。请使用本地静态服务器访问页面（例如 Live Server 或 http://localhost），不要直接 file:// 打开。`
    );
  }
}

async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  return img;
}

window.addEventListener("beforeunload", () => {
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
  }
  if (state.generatedURL) {
    URL.revokeObjectURL(state.generatedURL);
  }
  if (state.userImageURL) {
    URL.revokeObjectURL(state.userImageURL);
  }
});
