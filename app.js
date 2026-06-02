/**
 * ============================================
 * 视频展台 - 主应用逻辑
 * ChromeOS Document Camera Extension
 * ============================================
 *
 * 功能：
 * - 摄像头实时预览 & 拍照（仅内存保留，不保存文件）
 * - 选择本地图片
 * - 批注（画笔、荧光笔）
 * - 鼠标模式（不绘制，可拖拽/手势）
 * - 橡皮擦
 * - 撤销/重做
 * - 全局旋转（0°/90°/180°/270°）
 * - 缩略图弹出管理
 * - 下载合成图片
 */

// ===== State Manager =====
class AppState {
  constructor() {
    this.photos = [];               // 所有照片 { id, dataUrl, strokes }
    this.currentIndex = -1;         // 当前显示的照片索引
    this.loadFromStorage();         // 恢复上次会话
    this.isStreaming = false;       // 摄像头是否开启
    this.isCameraMode = true;       // true=摄像头预览, false=照片浏览
    this.annotationMode = 'pen';    // pointer | pen | highlighter | eraser
    this.penColor = '#3498db';
    this.penSize = 5;
    this.highlighterColor = '#f1c40f';
    this.highlighterSize = 20;
    this.eraserSize = 20;
    this.undoStack = [];
    this.redoStack = [];
    this.isDrawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.idCounter = 0;
    this.rotateDeg = 0;            // 全局旋转角度
  }

  // ===== localStorage 持久化 =====
  saveToStorage() {
    try {
      const data = {
        photos: this.photos.map(p => ({
          id: p.id, dataUrl: p.dataUrl, strokes: p.strokes,
        })),
        currentIndex: this.currentIndex,
        rotateDeg: this.rotateDeg,
        idCounter: this.idCounter,
      };
      localStorage.setItem('chromecam_photos', JSON.stringify(data));
    } catch (e) {
      // 超过 localStorage 限额时静默失败
      console.warn('localStorage save failed:', e.message);
    }
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem('chromecam_photos');
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data.photos || !Array.isArray(data.photos) || data.photos.length === 0) return false;
      this.photos = data.photos;
      this.currentIndex = data.currentIndex ?? this.photos.length - 1;
      this.rotateDeg = data.rotateDeg ?? 0;
      this.idCounter = data.idCounter ?? this.photos.length;
      return true;
    } catch (e) {
      console.warn('localStorage load failed:', e.message);
      return false;
    }
  }

  get currentTool() { return this.annotationMode; }
  set currentTool(v) { this.annotationMode = v; }

  get currentColor() {
    return this.annotationMode === 'highlighter'
      ? this.highlighterColor : this.penColor;
  }

  get currentSize() {
    if (this.annotationMode === 'highlighter') return this.highlighterSize;
    if (this.annotationMode === 'eraser') return this.eraserSize;
    return this.penSize;
  }

  get currentPhoto() {
    if (this.currentIndex < 0 || this.currentIndex >= this.photos.length) return null;
    return this.photos[this.currentIndex];
  }

  addPhoto(dataUrl) {
    const photo = {
      id: ++this.idCounter,
      dataUrl: dataUrl,
      createdAt: Date.now(),
      strokes: []
    };
    this.photos.push(photo);
    this.currentIndex = this.photos.length - 1;
    this.undoStack = [];
    this.redoStack = [];
    return photo;
  }

  removePhoto(index) {
    if (index < 0 || index >= this.photos.length) return;
    this.photos.splice(index, 1);
    if (this.photos.length === 0) {
      this.currentIndex = -1;
    } else if (this.currentIndex >= this.photos.length) {
      this.currentIndex = this.photos.length - 1;
    }
    this.undoStack = [];
    this.redoStack = [];
  }

  switchToPhoto(index) {
    if (index < 0 || index >= this.photos.length) return;
    this.currentIndex = index;
    this.undoStack = [];
    this.redoStack = [];
    this.isCameraMode = false;
  }

  addStroke(stroke) {
    const photo = this.currentPhoto;
    if (!photo) return;
    photo.strokes.push(stroke);
    this.undoStack.push(stroke);
    this.redoStack = [];
  }

  undo() {
    const photo = this.currentPhoto;
    if (!photo || this.undoStack.length === 0) return;
    const stroke = this.undoStack.pop();
    this.redoStack.push(stroke);
    const idx = photo.strokes.lastIndexOf(stroke);
    if (idx >= 0) photo.strokes.splice(idx, 1);
  }

  redo() {
    const photo = this.currentPhoto;
    if (!photo || this.redoStack.length === 0) return;
    const stroke = this.redoStack.pop();
    this.undoStack.push(stroke);
    photo.strokes.push(stroke);
  }

  clearAnnotations() {
    const photo = this.currentPhoto;
    if (!photo) return;
    if (photo.strokes.length === 0) return;
    this.undoStack = [];
    this.redoStack = [];
    photo.strokes = [];
  }

  // 全局旋转
  rotate() {
    this.rotateDeg = (this.rotateDeg + 90) % 360;
    return this.rotateDeg;
  }
}

// ===== Canvas Drawing Engine =====
class AnnotationEngine {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.setupCanvas();
  }

  setupCanvas() {
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.redrawAll();
  }

  getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
      e.preventDefault();
    } else {
      clientX = e.clientX || e.offsetX;
      clientY = e.clientY || e.offsetY;
    }
    return {
      x: (clientX - rect.left) * (this.canvas.width / rect.width),
      y: (clientY - rect.top) * (this.canvas.height / rect.height)
    };
  }

  startDraw(e) {
    if (this.state.annotationMode === 'pointer') return;
    if (!this.state.currentPhoto) return;
    if (this.state.isCameraMode) return;
    if (this.state.annotationMode === 'eraser') {
      this.startErase(e);
      return;
    }
    this.state.isDrawing = true;
    const pos = this.getPos(e);
    this.state.lastX = pos.x;
    this.state.lastY = pos.y;

    this.currentStroke = {
      type: this.state.annotationMode,
      color: this.state.currentColor,
      size: this.state.currentSize,
      points: [{ x: pos.x, y: pos.y }]
    };
  }

  draw(e) {
    if (this.state.annotationMode === 'pointer') return;
    if (!this.state.isDrawing) return;
    if (this.state.annotationMode === 'eraser') {
      this.erase(e);
      return;
    }

    const pos = this.getPos(e);
    const ctx = this.ctx;
    const stroke = this.currentStroke;
    stroke.points.push({ x: pos.x, y: pos.y });

    ctx.beginPath();
    ctx.moveTo(this.state.lastX, this.state.lastY);
    ctx.lineTo(pos.x, pos.y);

    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.type === 'highlighter' ? 0.3 : 1;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.stroke();
    ctx.globalAlpha = 1;
    this.state.lastX = pos.x;
    this.state.lastY = pos.y;
  }

  endDraw(e) {
    if (this.state.annotationMode === 'pointer') return;
    if (!this.state.isDrawing) return;
    if (this.state.annotationMode === 'eraser') {
      this.endErase(e);
      return;
    }
    this.state.isDrawing = false;
    if (this.currentStroke && this.currentStroke.points.length > 0) {
      this.state.addStroke(this.currentStroke);
    }
    this.currentStroke = null;
  }

  // 橡皮擦模式
  startErase(e) {
    this.state.isDrawing = true;
    const pos = this.getPos(e);
    this.lastEraseX = pos.x;
    this.lastEraseY = pos.y;
    this.doErase(pos.x, pos.y);
  }

  erase(e) {
    if (!this.state.isDrawing) return;
    const pos = this.getPos(e);
    this.doErase(pos.x, pos.y);
  }

  endErase(e) {
    this.state.isDrawing = false;
  }

  doErase(x, y) {
    const ctx = this.ctx;
    const size = this.state.currentSize;

    const photo = this.state.currentPhoto;
    if (!photo) return;

    // 用圆清除画布
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    // 从 strokes 中移除被擦除笔画
    const strokesToRemove = [];
    for (const stroke of photo.strokes) {
      let shouldRemove = false;
      for (const pt of stroke.points) {
        const dist = Math.sqrt((pt.x - x) ** 2 + (pt.y - y) ** 2);
        if (dist < size / 2 + stroke.size / 2) {
          shouldRemove = true;
          break;
        }
      }
      if (shouldRemove) {
        strokesToRemove.push(stroke);
      }
    }

    for (const s of strokesToRemove) {
      const idx = photo.strokes.indexOf(s);
      if (idx >= 0) photo.strokes.splice(idx, 1);
    }

    this.redrawAll();
  }

  redrawAll() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const photo = this.state.currentPhoto;
    if (!photo) return;

    for (const stroke of photo.strokes) {
      if (stroke.points.length < 2) continue;

      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }

      if (stroke.type === 'highlighter') {
        ctx.strokeStyle = stroke.color;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = stroke.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      } else {
        ctx.strokeStyle = stroke.color;
        ctx.globalAlpha = 1;
        ctx.lineWidth = stroke.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }

      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

// ===== Main Application =====
class DocCameraApp {
  constructor() {
    this.state = new AppState();
    this.initElements();
    this.bindEvents();
    this.updateUI();
    // 默认启动摄像头
    this.setupBeforeUnload();
    setTimeout(() => this.startCamera(), 100);
  }

  initElements() {
    // 批注工具按钮
    this.btnPointer = document.getElementById('btnPointer');
    this.btnPen = document.getElementById('btnPen');
    this.btnHighlighter = document.getElementById('btnHighlighter');
    this.btnEraser = document.getElementById('btnEraser');
    this.btnRotate = document.getElementById('btnRotate');
    this.rotateLabel = document.getElementById('rotateLabel');
    this.btnToolSettings = document.getElementById('btnToolSettings');

    // 画笔 & 拍照
    this.btnSnapshot = document.getElementById('btnSnapshot');
    this.btnBackCam = document.getElementById('btnBackCam');
    this.btnImage = document.getElementById('btnImage');
    this.btnUndo = document.getElementById('btnUndo');
    this.btnRedo = document.getElementById('btnRedo');
    this.btnClearAll = document.getElementById('btnClearAll');
    this.btnDownload = document.getElementById('btnDownload');

    // 颜色/粗细
    this.colorButtons = document.querySelectorAll('.color-btn');
    this.sizeButtons = document.querySelectorAll('.size-btn');
    this.toolSettingsPopup = document.getElementById('toolSettingsPopup');

    // 内容区域
    this.video = document.getElementById('video');
    this.capturedImage = document.getElementById('capturedImage');
    this.cameraContainer = document.getElementById('camera-container');
    this.imageContainer = document.getElementById('image-container');
    this.overlay = document.getElementById('overlay');
    this.imageOverlay = document.getElementById('imageOverlay');

    // 图片库弹出
    this.btnGallery = document.getElementById('btnGallery');
    this.galleryBadge = document.getElementById('galleryBadge');
    this.galleryPopup = document.getElementById('gallery-popup');
    this.btnGalleryClose = document.getElementById('btnGalleryClose');
    this.btnGalleryDeleteAll = document.getElementById('btnGalleryDeleteAll');
    this.galleryThumbnails = document.getElementById('galleryThumbnails');

    // 文件输入
    this.fileInput = document.getElementById('fileInput');

    // 底部批注栏引用（全屏隐光标用）
    this.annotBar = document.getElementById('annot-float-bar');

    // 照片信息显示
    this.photoInfo = document.getElementById('photoInfo');

    // 批注引擎
    this.overlayEngine = new AnnotationEngine(this.overlay, this.state);
    this.imageOverlayEngine = new AnnotationEngine(this.imageOverlay, this.state);

    this.currentEngine = this.overlayEngine;
  }

  bindEvents() {
    // 工具选择
    this.btnPointer.addEventListener('click', () => this.setTool('pointer'));
    this.btnPen.addEventListener('click', () => this.setTool('pen'));
    this.btnHighlighter.addEventListener('click', () => this.setTool('highlighter'));
    this.btnEraser.addEventListener('click', () => this.setTool('eraser'));
    this.btnRotate.addEventListener('click', () => this.doRotate());
    this.btnToolSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleToolSettingsPopup();
    });

    // 操作
    this.btnSnapshot.addEventListener('click', () => this.takeSnapshot());
    this.btnBackCam.addEventListener('click', () => this.switchToCamera());
    this.btnImage.addEventListener('click', () => this.pickImage());
    this.btnUndo.addEventListener('click', () => this.undo());
    this.btnRedo.addEventListener('click', () => this.redo());
    this.btnClearAll.addEventListener('click', () => this.clearAnnotations());
    this.btnDownload.addEventListener('click', () => this.download());

    // 颜色选择
    this.colorButtons.forEach(btn => {
      btn.addEventListener('click', () => this.setColor(btn.dataset.color));
    });

    // 粗细选择
    this.sizeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.setSize(parseInt(btn.dataset.size)));
    });

    // 文件输入
    this.fileInput.addEventListener('change', (e) => this.handleFiles(e));

    // 鼠标/触摸绘图事件
    this.setupDrawingEvents(this.overlay, this.overlayEngine);
    this.setupDrawingEvents(this.imageOverlay, this.imageOverlayEngine);

    // 键盘快捷键
    document.addEventListener('keydown', (e) => this.handleKeydown(e));

    // ⚙️ 工具设置弹出面板：点击外部关闭
    document.addEventListener('click', (e) => {
      const popup = this.toolSettingsPopup;
      const trigger = this.btnToolSettings;
      if (!popup || popup.classList.contains('hidden')) return;
      if (!popup.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
        this.hideToolSettingsPopup();
      }
    });
    window.addEventListener('resize', () => {
      this.overlayEngine.resize();
      this.imageOverlayEngine.resize();
    });

    // 全屏隐光标：鼠标不动隐藏批注栏和光标
    let hideCursorTimer;
    document.addEventListener('mousemove', () => {
      clearTimeout(hideCursorTimer);
      document.body.classList.remove('cursor-hidden');
      this.annotBar.style.opacity = '1';
      this.annotBar.style.pointerEvents = 'auto';
      hideCursorTimer = setTimeout(() => {
        if (document.fullscreenElement) {
          document.body.classList.add('cursor-hidden');
          this.annotBar.style.opacity = '0';
          this.annotBar.style.pointerEvents = 'none';
        }
      }, 3000);
    });

    // 图片库 FAB 打开/关闭
    this.btnGallery.addEventListener('click', () => {
      this.galleryPopup.classList.toggle('hidden');
      this.renderGallery();
    });

    this.btnGalleryClose.addEventListener('click', () => {
      this.galleryPopup.classList.add('hidden');
    });

    this.btnGalleryDeleteAll.addEventListener('click', () => {
      this.deleteAllPhotos();
    });

    // 点击外部关闭弹出
    document.addEventListener('click', (e) => {
      if (!this.galleryPopup.classList.contains('hidden') &&
          !e.target.closest('#gallery-fab')) {
        this.galleryPopup.classList.add('hidden');
      }
    });

    // 图片库缩略图点击委托
    this.galleryThumbnails.addEventListener('click', (e) => {
      const item = e.target.closest('.gallery-thumb-item');
      if (!item) return;
      const delBtn = e.target.closest('.gallery-del-btn');
      if (delBtn) {
        const idx = parseInt(item.dataset.index);
        this.deletePhoto(idx);
        return;
      }
      const idx = parseInt(item.dataset.index);
      this.selectPhoto(idx);
      this.galleryPopup.classList.add('hidden');
    });
  }

  setupDrawingEvents(canvas, engine) {
    canvas.addEventListener('mousedown', (e) => {
      if (this.state.annotationMode === 'pointer') return;
      if (!this.state.currentPhoto && this.state.annotationMode !== 'eraser') return;
      if (this.state.isCameraMode) return;
      engine.startDraw(e);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.state.annotationMode === 'pointer') return;
      if (!this.state.isDrawing) return;
      engine.draw(e);
    });

    canvas.addEventListener('mouseup', (e) => {
      engine.endDraw(e);
    });

    canvas.addEventListener('mouseleave', (e) => {
      if (this.state.isDrawing) engine.endDraw(e);
    });

    canvas.addEventListener('touchstart', (e) => {
      if (this.state.annotationMode === 'pointer') return;
      if (!this.state.currentPhoto && this.state.annotationMode !== 'eraser') return;
      if (this.state.isCameraMode) return;
      engine.startDraw(e);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (this.state.annotationMode === 'pointer') return;
      if (!this.state.isDrawing) return;
      engine.draw(e);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      engine.endDraw(e);
    });
  }

  handleKeydown(e) {
    // 空格 = 拍照
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      this.takeSnapshot();
    }
    // Ctrl+Z = 撤销
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    }
    // Ctrl+Shift+Z / Ctrl+Y = 重做
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
    }
    // Ctrl+R = 旋转
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
      e.preventDefault();
      this.doRotate();
    }
    // Ctrl+S = 下载
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.download();
    }
    // F = 全屏
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.toggleFullscreen();
    }
    // Escape = 退出批注到鼠标模式
    if (e.key === 'Escape') {
      if (document.fullscreenElement) {
        document.exitFullscreen();
        e.preventDefault();
        return;
      }
      if (this.state.currentTool !== 'pointer') {
        this.setTool('pointer');
      } else {
        this.setTool('pen');
      }
    }
    // ? = 快捷键帮助
    if (e.key === '?' && !e.shiftKey) {
      this.showShortcutHelp();
    }
    if (e.key === '/' && e.shiftKey) {
      e.preventDefault();
      this.showShortcutHelp();
    }
  }

  // ===== 摄像头控制 =====
  async toggleCamera() {
    if (this.state.isStreaming) {
      this.stopCamera();
    } else {
      await this.startCamera();
    }
  }

  async startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'environment'
        },
        audio: false
      });

      this.video.srcObject = stream;
      await this.video.play();
      this.state.isStreaming = true;
      this.cameraContainer.classList.add('streaming');

      this.switchToCameraMode();
      this.updateUI();
    } catch (err) {
      console.error('摄像头启动失败:', err);
      if (err.name === 'NotAllowedError') {
        this.showToast('请允许使用摄像头权限');
      } else if (err.name === 'NotFoundError') {
        this.showToast('未检测到摄像头设备');
      } else {
        this.showToast('摄像头启动失败: ' + err.message);
      }
    }
  }

  stopCamera() {
    const stream = this.video.srcObject;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      this.video.srcObject = null;
    }
    this.state.isStreaming = false;
    this.cameraContainer.classList.remove('streaming');
    this.updateUI();
  }

  switchToCameraMode() {
    this.state.isCameraMode = true;
    this.cameraContainer.classList.add('active');
    this.imageContainer.classList.remove('active');
    this.btnBackCam.style.display = 'none';

    // 摄像头模式下禁用 overlay canvas 的绘制事件
    this.overlay.style.pointerEvents = 'none';
    this.imageOverlay.style.pointerEvents = 'none';

    this.currentEngine = this.overlayEngine;
  }

  switchToCamera() {
    this.switchToCameraMode();
    if (!this.state.isStreaming) {
      this.startCamera();
    }
    this.updateUI();
  }

  // ===== 拍照 =====
  takeSnapshot() {
    if (!this.state.isStreaming) {
      this.showToast('请先开启摄像头');
      return;
    }

    // 闪光效果
    this.showFlash();

    // 从视频帧截取图片
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth || 1280;
    canvas.height = this.video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

    // 添加到照片列表
    const photo = this.state.addPhoto(dataUrl);
    this.displayPhoto(photo);

    // 切换到照片浏览模式
    this.switchToImageView();

    this.updateUI();
    this.state.saveToStorage();
    this.showToast('📸 已拍照');
  }

  showFlash() {
    const flash = document.createElement('div');
    flash.className = 'flash-overlay';
    this.cameraContainer.appendChild(flash);
    setTimeout(() => flash.remove(), 300);
  }

  // ===== 全屏切换 =====
  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  // ===== 选择图片 =====
  pickImage() {
    if (this.state.isStreaming) {
      this.stopCamera();
    }
    this.fileInput.click();
  }

  // ===== 页面关闭保护 =====
  setupBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
      if (this.state.photos.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  handleFiles(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const photo = this.state.addPhoto(dataUrl);
        this.displayPhoto(photo);
        this.switchToImageView();
        this.updateUI();
        this.state.saveToStorage();
      };
      reader.readAsDataURL(file);
    }

    this.fileInput.value = '';
  }

  // ===== 显示照片 =====
  displayPhoto(photo) {
    this.capturedImage.src = photo.dataUrl;
  }

  switchToImageView() {
    this.state.isCameraMode = false;
    this.cameraContainer.classList.remove('active');
    this.imageContainer.classList.add('active');
    this.btnBackCam.style.display = 'inline-flex';

    // 图片模式下启用 imageOverlay 绘制（除非是鼠标模式）
    this.overlay.style.pointerEvents = 'none';
    this.imageOverlay.style.pointerEvents = 
      this.state.annotationMode === 'pointer' ? 'none' : 'auto';

    this.currentEngine = this.imageOverlayEngine;

    // 等图片加载完后重置 canvas 大小
    setTimeout(() => {
      this.imageOverlayEngine.resize();
    }, 100);
  }

  // ===== 全局旋转 =====
  doRotate() {
    const deg = this.state.rotate();
    this.rotateLabel.textContent = deg + '°';

    // 应用到视频和图片
    this.video.style.transform = `rotate(${deg}deg)`;
    this.capturedImage.style.transform = `rotate(${deg}deg)`;

    this.showToast(`🔄 旋转 ${deg}°`);
  }

  // ===== 缩略图弹出管理 =====
  renderGallery() {
    this.galleryThumbnails.innerHTML = '';

    // 更新徽章
    this.galleryBadge.textContent = this.state.photos.length;

    if (this.state.photos.length === 0) {
      this.galleryThumbnails.innerHTML =
        `<div class="gallery-thumb-empty">暂无照片</div>`;
      return;
    }

    for (let i = 0; i < this.state.photos.length; i++) {
      const photo = this.state.photos[i];
      const item = document.createElement('div');
      item.className = 'gallery-thumb-item' +
        (i === this.state.currentIndex ? ' active' : '');
      item.dataset.index = i;
      item.innerHTML = `
        <img src="${photo.dataUrl}" alt="照片 ${i + 1}">
        <button class="gallery-del-btn">✕</button>
      `;
      this.galleryThumbnails.appendChild(item);
    }

    // 自动滚动到最新照片（仅当 gallery 打开时）
    if (!this.galleryPopup.classList.contains('hidden') && this.galleryThumbnails.scrollTo) {
      this.galleryThumbnails.scrollTo({
        left: this.galleryThumbnails.scrollWidth,
        behavior: 'smooth'
      });
    }
  }

  selectPhoto(index) {
    this.state.switchToPhoto(index);
    const photo = this.state.currentPhoto;
    if (photo) {
      this.displayPhoto(photo);
      this.switchToImageView();
    }
    this.renderGallery();
    this.currentEngine.redrawAll();
    this.updateUI();
  }

  deletePhoto(index) {
    this.state.removePhoto(index);
    this.renderGallery();

    if (this.state.photos.length === 0) {
      this.showImageViewHint(false);
      if (this.state.isStreaming) {
        this.switchToCameraMode();
      } else {
        this.capturedImage.src = '';
        this.imageContainer.classList.remove('active');
        this.cameraContainer.classList.add('active');
        this.state.isCameraMode = true;
      }
    } else {
      const photo = this.state.currentPhoto;
      if (photo) {
        this.displayPhoto(photo);
        this.currentEngine.redrawAll();
      }
    }
    this.updateUI();
    this.state.saveToStorage();
  }

  deleteAllPhotos() {
    if (this.state.photos.length === 0) {
      this.showToast('没有照片可删除');
      return;
    }
    this.showConfirm('确认删除全部照片？', () => {
      this.state.photos = [];
      this.state.currentIndex = -1;
      this.state.undoStack = [];
      this.state.redoStack = [];

      if (this.state.isStreaming) {
        this.switchToCameraMode();
      } else {
        this.capturedImage.src = '';
        this.imageContainer.classList.remove('active');
        this.cameraContainer.classList.add('active');
        this.state.isCameraMode = true;
      }
      this.showImageViewHint(false);
      this.galleryPopup.classList.add('hidden');
      this.state.saveToStorage();
      this.updateUI();
      this.showToast('🗑️ 已删除全部照片');
    });
  }
  // ===== 批注工具 =====
  setTool(tool) {
    this.state.currentTool = tool;
    this.btnPointer.classList.toggle('active', tool === 'pointer');
    this.btnPen.classList.toggle('active', tool === 'pen');
    this.btnHighlighter.classList.toggle('active', tool === 'highlighter');
    this.btnEraser.classList.toggle('active', tool === 'eraser');

    // 切换绘图工具时自动打开设置面板（鼠标模式关闭）
    if (tool === 'pointer') {
      this.hideToolSettingsPopup();
    } else {
      this.showToolSettingsPopup();
    }

    // 设置光标样式
    const canvases = [this.overlay, this.imageOverlay];
    canvases.forEach(c => {
      c.classList.remove('eraser-mode', 'pointer-mode');
      if (tool === 'eraser') c.classList.add('eraser-mode');
      if (tool === 'pointer') c.classList.add('pointer-mode');
    });

    // 更新 imageOverlay 的 pointer-events（仅图片模式下有效）
    if (!this.state.isCameraMode) {
      this.imageOverlay.style.pointerEvents = tool === 'pointer' ? 'none' : 'auto';
    }
  }

  setColor(color) {
    if (this.state.annotationMode === 'highlighter') {
      this.state.highlighterColor = color;
    } else {
      this.state.penColor = color;
    }
    this.colorButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
  }

  setSize(size) {
    if (this.state.annotationMode === 'eraser') {
      this.state.eraserSize = size;
    } else if (this.state.annotationMode === 'highlighter') {
      this.state.highlighterSize = size;
    } else {
      this.state.penSize = size;
    }
    this.sizeButtons.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.size) === size);
    });
  }

  // ===== 工具设置弹出面板（颜色 + 粗细） =====
  toggleToolSettingsPopup() {
    const popup = this.toolSettingsPopup;
    if (popup.classList.contains('hidden')) {
      this.showToolSettingsPopup();
    } else {
      this.hideToolSettingsPopup();
    }
  }
  showToolSettingsPopup() {
    this.toolSettingsPopup.classList.remove('hidden');
    this.btnToolSettings.classList.add('active');
  }
  hideToolSettingsPopup() {
    this.toolSettingsPopup.classList.add('hidden');
    this.btnToolSettings.classList.remove('active');
  }

  // ===== 撤销/重做 =====
  undo() {
    this.state.undo();
    this.currentEngine.redrawAll();
    this.updateUI();
  }

  redo() {
    this.state.redo();
    this.currentEngine.redrawAll();
    this.updateUI();
  }

  clearAnnotations() {
    if (!this.state.currentPhoto) return;
    if (this.state.currentPhoto.strokes.length === 0) return;

    this.showConfirm('确认清除所有批注？', () => {
      this.state.clearAnnotations();
      this.currentEngine.redrawAll();
      this.updateUI();
    });
  }

  // ===== 下载 =====
  download() {
    const photo = this.state.currentPhoto;
    if (!photo) {
      this.showToast('没有可下载的照片');
      return;
    }

    const canvas = document.createElement('canvas');
    const img = new Image();
    img.onload = () => {
      const deg = this.state.rotateDeg;
      const rad = deg * Math.PI / 180;
      // 旋转后需要额外空间
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const w = img.width;
      const h = img.height;
      canvas.width = Math.round(w * cos + h * sin);
      canvas.height = Math.round(w * sin + h * cos);
      const ctx = canvas.getContext('2d');

      // 平移到中心并旋转
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);

      // 批注也要按相同旋转来画
      const overlayW = this.currentEngine.canvas.width;
      const overlayH = this.currentEngine.canvas.height;
      const scaleX = w / overlayW;
      const scaleY = h / overlayH;

      ctx.save();
      // 批注坐标在原图坐标空间，旋转已应用，直接画
      for (const stroke of photo.strokes) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(
          (stroke.points[0].x * scaleX) - w / 2,
          (stroke.points[0].y * scaleY) - h / 2
        );
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(
            (stroke.points[i].x * scaleX) - w / 2,
            (stroke.points[i].y * scaleY) - h / 2
          );
        }
        if (stroke.type === 'highlighter') {
          ctx.strokeStyle = stroke.color;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = stroke.size * (scaleX + scaleY) / 2;
        } else {
          ctx.strokeStyle = stroke.color;
          ctx.globalAlpha = 1;
          ctx.lineWidth = stroke.size * (scaleX + scaleY) / 2;
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      ctx.restore();

      const link = document.createElement('a');
      link.download = `视频展台_${new Date().toISOString().slice(0,19).replace(/[:-]/g, '')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      this.showToast('✅ 已下载');
    };
    img.src = photo.dataUrl;
  }

  // ===== UI 更新 =====
  updateUI() {
    const hasPhoto = this.state.currentPhoto !== null;
    const hasStrokes = hasPhoto && this.state.currentPhoto.strokes.length > 0;
    const canUndo = this.state.undoStack.length > 0;
    const canRedo = this.state.redoStack.length > 0;

    this.btnUndo.disabled = !canUndo;
    this.btnRedo.disabled = !canRedo;
    this.btnDownload.disabled = !hasPhoto;
    this.btnClearAll.style.opacity = hasStrokes ? '1' : '0.4';

    // 更新照片信息
    if (this.photoInfo) {
      if (hasPhoto) {
        const total = this.state.photos.length;
        const idx = this.state.currentIndex + 1;
        this.photoInfo.textContent = `📷 ${idx}/${total}`;
        this.photoInfo.style.display = 'block';
      } else {
        this.photoInfo.style.display = 'none';
      }
    }

    this.renderGallery();
  }

  // 切换到图片视图时显示可批注提示
  showImageViewHint(show) {
    // 在图片容器上添加一个提示层
    let hint = this.imageContainer.querySelector('.image-view-hint');
    if (show && !hint) {
      hint = document.createElement('div');
      hint.className = 'image-view-hint';
      hint.textContent = '选择上方工具开始批注 ✏️';
      hint.style.cssText = `
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.6);
        color: #fff;
        padding: 8px 20px;
        border-radius: 20px;
        font-size: 13px;
        z-index: 20;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.5s ease;
      `;
      this.imageContainer.appendChild(hint);
      // 淡入
      requestAnimationFrame(() => { hint.style.opacity = '1'; });
      // 3s 后淡出
      setTimeout(() => {
        hint.style.opacity = '0';
        setTimeout(() => hint.remove(), 500);
      }, 3000);
    }
  }

  // 自定义确认对话框（替代原生 confirm）
  showConfirm(message, onConfirm) {
    // 移除已有
    const existing = document.querySelector('.app-confirm-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      animation: fadeIn 0.15s ease-out;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: #1e2a4a;
      border: 1px solid #2a3a5a;
      border-radius: 12px;
      padding: 24px 28px;
      max-width: 360px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    `;

    const msg = document.createElement('div');
    msg.textContent = message;
    msg.style.cssText = `
      color: #e8e8e8;
      font-size: 15px;
      margin-bottom: 20px;
      text-align: center;
    `;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: center;
    `;

    const btnCancel = document.createElement('button');
    btnCancel.textContent = '取消';
    btnCancel.style.cssText = `
      padding: 8px 24px;
      border: 1px solid #2a3a5a;
      border-radius: 8px;
      background: transparent;
      color: #a0a8b8;
      cursor: pointer;
      font-size: 14px;
    `;

    const btnOk = document.createElement('button');
    btnOk.textContent = '确认';
    btnOk.style.cssText = `
      padding: 8px 24px;
      border: none;
      border-radius: 8px;
      background: #4285F4;
      color: #fff;
      cursor: pointer;
      font-size: 14px;
    `;

    btnCancel.onclick = () => overlay.remove();
    btnOk.onclick = () => { overlay.remove(); onConfirm(); };
    btnCancel.onmouseover = () => { btnCancel.style.background = 'rgba(255,255,255,0.08)'; };
    btnCancel.onmouseout = () => { btnCancel.style.background = 'transparent'; };
    btnOk.onmouseover = () => { btnOk.style.background = '#5a9cff'; };
    btnOk.onmouseout = () => { btnOk.style.background = '#4285F4'; };

    // 点击遮罩关闭
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);
    box.appendChild(msg);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ===== 快捷键帮助面板 =====
  showShortcutHelp() {
    const existing = document.getElementById('shortcut-help-overlay');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'shortcut-help-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7); z-index: 9998;
      display: flex; align-items: center; justify-content: center;
      animation: fadeIn 0.15s ease-out;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      background: #1e2a4a; border: 1px solid #2a3a5a;
      border-radius: 14px; padding: 24px 28px;
      max-width: 360px; width: 90%;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      color: #e8e8e8;
    `;

    box.innerHTML = `
      <div style="font-size:16px;font-weight:600;margin-bottom:16px">⌨️ 快捷键</div>
      <table style="width:100%;font-size:13px;line-height:2">
        <tr><td><kbd>Space</kbd></td><td>📸 拍照</td></tr>
        <tr><td><kbd>F</kbd></td><td>⛶ 全屏</td></tr>
        <tr><td><kbd>Ctrl+Z</kbd></td><td>↩️ 撤销</td></tr>
        <tr><td><kbd>Ctrl+Y</kbd></td><td>↪️ 重做</td></tr>
        <tr><td><kbd>Ctrl+R</kbd></td><td>🔄 旋转</td></tr>
        <tr><td><kbd>Ctrl+S</kbd></td><td>⬇️ 下载</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>🖱️ 切换 鼠标/画笔</td></tr>
        <tr><td><kbd>?</kbd></td><td>❓ 本面板</td></tr>
      </table>
      <div style="text-align:right;margin-top:12px">
        <button id="shortcut-close-btn" style="
          background:#4285F4; color:#fff; border:none;
          border-radius:8px; padding:6px 20px; cursor:pointer; font-size:13px;
        ">我知道了</button>
      </div>
      <style>
        kbd {
          background: rgba(255,255,255,0.1);
          padding: 1px 6px; border-radius: 4px;
          font-family: monospace; font-size: 12px;
          border: 1px solid rgba(255,255,255,0.15);
        }
      </style>
    `;

    // 按 Escape 关闭
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') overlay.remove();
    });
    overlay.setAttribute('tabindex', '0');  // 可聚焦才能收键盘事件
    overlay.focus();

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => {
      const btn = document.getElementById('shortcut-close-btn');
      if (btn) btn.onclick = () => overlay.remove();
    }, 0);
  }

  // ===== Toast 通知 =====
  showToast(message) {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 90px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.85);
      color: #fff;
      padding: 10px 24px;
      border-radius: 20px;
      font-size: 14px;
      z-index: 9999;
      pointer-events: none;
      animation: toastFadeIn 0.2s ease-out;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease-out';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
}

// ===== 启动应用 =====
document.addEventListener('DOMContentLoaded', () => {
  // 添加 toast 动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes toastFadeIn {
      from { opacity: 0; transform: translateX(-50%) translateY(10px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);

  const app = new DocCameraApp();
  window.app = app;
});
