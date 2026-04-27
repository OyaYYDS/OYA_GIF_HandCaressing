#!/usr/bin/env python3
"""
将整个 GIF 生成器项目打包成单个独立 HTML 文件。
运行方式：python build_standalone.py
输出：standalone.html
"""
import base64
import os
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def read_text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def read_b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')

# ── 读取所有源文件 ───────────────────────────────────────────────
css        = read_text(os.path.join(BASE_DIR, 'style.css'))
gif_js     = read_text(os.path.join(BASE_DIR, 'gif.js'))
worker_js  = read_text(os.path.join(BASE_DIR, 'gif.worker.real.js'))
script_js  = read_text(os.path.join(BASE_DIR, 'script.js'))

# ── 手部图片 → base64 data URL ────────────────────────────────────
hand_data_urls = []
for i in range(1, 10):
    b64 = read_b64(os.path.join(BASE_DIR, 'hand', f'{i}.png'))
    hand_data_urls.append(f'data:image/png;base64,{b64}')

# 生成 JS 数组字面量
hand_js_array = '[\n  "' + '",\n  "'.join(hand_data_urls) + '"\n]'

# ── 修改 script.js ───────────────────────────────────────────────
# 1) 替换 preloadTemplates：改为从内嵌 base64 加载
old_preload = '''async function preloadTemplates() {
  const promises = [];
  for (let i = 1; i <= CONFIG.TOTAL_FRAMES; i += 1) {
    // 统一先转 blob URL，再作为本地对象资源加载，尽量避免画布被跨域污染。
    promises.push(loadLocalSafeImage(`hand/${i}.png`));
  }
  state.templates = await Promise.all(promises);
}'''

new_preload = '''async function preloadTemplates() {
  // 从内嵌 base64 数据 URL 直接加载，无跨域问题
  const promises = HAND_IMAGES_DATA.map((dataUrl) => loadImage(dataUrl));
  state.templates = await Promise.all(promises);
}'''

if old_preload not in script_js:
    # 也许换行符不同，做宽松替换
    script_js = re.sub(
        r'async function preloadTemplates\(\)\s*\{.*?state\.templates = await Promise\.all\(promises\);\s*\}',
        new_preload,
        script_js,
        flags=re.DOTALL
    )
else:
    script_js = script_js.replace(old_preload, new_preload)

# 2) 替换 workerScript: 改为使用 Blob URL（在 generateGIF 函数里）
script_js = script_js.replace(
    'workerScript: "gif.worker.js"',
    'workerScript: window.__gifWorkerBlobURL__'
)

# 3) 移除 assertCanvasReadable 里的报错提示中"使用本地服务器"的建议（已不需要）
script_js = script_js.replace(
    '请使用本地静态服务器访问页面（例如 Live Server 或 http://localhost），不要直接 file:// 打开。',
    '请尝试刷新页面后重试。'
)

# ── 转义 worker JS 中的 </script> 标签（安全起见）───────────────
worker_js_escaped = worker_js.replace('</script>', '<\\/script>')
gif_js_escaped    = gif_js.replace('</script>', '<\\/script>')
script_js_escaped = script_js.replace('</script>', '<\\/script>')

# ── 组装独立 HTML ────────────────────────────────────────────────
html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>手部挤压 GIF 生成器</title>
  <style>
{css}
  </style>
</head>
<body>
  <div class="bg-shape bg-shape-a" aria-hidden="true"></div>
  <div class="bg-shape bg-shape-b" aria-hidden="true"></div>

  <main class="app">
    <header class="app-header">
      <p class="eyebrow">Pure Frontend GIF Tool</p>
      <h1>手部挤压 GIF 表情生成器</h1>
      <p class="desc">上传一张图片，自动套用 9 帧手部模板并导出透明背景 GIF。</p>
    </header>

    <section class="panel controls">
      <label class="upload-area" id="dropZone" for="fileInput">
        <input id="fileInput" type="file" accept="image/*" />
        <span class="upload-title">点击或拖拽上传图片</span>
        <span class="upload-sub">支持 png / jpg / webp，全部在本地处理</span>
      </label>

      <div class="row">
        <label for="speedMode">速度模式</label>
        <select id="speedMode">
          <option value="fast">快速（10 ms）</option>
          <option value="normal" selected>普通（30 ms）</option>
          <option value="slow">慢速（90 ms）</option>
        </select>
      </div>

      <div class="actions">
        <button id="generateBtn" type="button">生成 GIF</button>
        <button id="downloadBtn" type="button" disabled>下载 GIF</button>
      </div>

      <div class="progress-wrap">
        <progress id="progressBar" value="0" max="100"></progress>
        <p id="statusText">等待上传图片...</p>
      </div>
    </section>

    <section class="panel preview">
      <div class="preview-block">
        <h2>实时预览</h2>
        <div class="checkerboard">
          <canvas id="previewCanvas" width="520" height="520"></canvas>
        </div>
      </div>

      <div class="preview-block">
        <h2>导出结果</h2>
        <div class="checkerboard result-box">
          <img id="resultGif" alt="GIF 导出结果预览" />
          <p id="resultHint">生成后将显示在这里</p>
        </div>
      </div>
    </section>
  </main>

  <!-- 1. gif.js 编码库 -->
  <script>
{gif_js_escaped}
  </script>

  <!-- 2. 创建 Worker Blob URL（避免 file:// 跨域限制） -->
  <script>
  (function () {{
    var workerCode = {repr(worker_js)};
    var blob = new Blob([workerCode], {{ type: 'application/javascript' }});
    window.__gifWorkerBlobURL__ = URL.createObjectURL(blob);
  }})();
  </script>

  <!-- 3. 手部模板图片（base64 内嵌） -->
  <script>
  var HAND_IMAGES_DATA = {hand_js_array};
  </script>

  <!-- 4. 主逻辑 -->
  <script>
{script_js_escaped}
  </script>
</body>
</html>'''

out_path = os.path.join(BASE_DIR, 'standalone.html')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html)

size_kb = os.path.getsize(out_path) / 1024
print(f'✅ 生成成功: standalone.html  ({size_kb:.1f} KB)')
