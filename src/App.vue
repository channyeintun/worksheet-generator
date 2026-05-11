<script setup>
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import HanziWriter from "hanzi-writer";
import { Icon } from "@iconify/vue/offline";
import googleGmail from "@iconify-icons/logos/google-gmail";
import telegram from "@iconify-icons/logos/telegram";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, watch } from "vue";
import { pinyin } from "pinyin-pro";
import defaultWordsText from "../words.txt?raw";

const strokeDataBaseUrl = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1";
const strokeAnimationIntervalMs = 700;
const wordAnimationLoopDelayMs = 600;
const mobileAnimationModalBreakpointPx = 720;
const animationExportFrameDelayMs = 80;
const animationExportPaletteSize = 256;
const animationExportBoxSizeMultiplier = 3;
const animationExportMinBoxSize = 224;
const animationExportMaxBoxSize = 320;
const animationExportPaddingRatio = 0.12;
const animationExportMinPadding = 18;
const animationExportMaxPadding = 40;
const animationExportMaxScale = 2;
const animationExportVideoBitsPerSecond = 5_000_000;
const animationVideoFormats = [
  { mimeType: "video/mp4;codecs=h264", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

const defaults = {
  title: "Hanyu-1 Hanzi Writing",
  footerText: "",
  rowsPerPage: 10,
  totalBoxes: 12,
  traceCopies: 7,
  showPinyin: true,
};

const defaultWords = parseWords(defaultWordsText);

const worksheetTitle = ref(defaults.title);
const footerText = ref(defaults.footerText);
const rowsPerPage = ref(String(defaults.rowsPerPage));
const totalBoxes = ref(String(defaults.totalBoxes));
const traceCopies = ref(String(defaults.traceCopies));
const showPinyin = ref(defaults.showPinyin);
const selectedWordsText = ref(defaultWords.join("\n"));
const wordSearch = ref("");
const previewRef = ref(null);
const animationPreviewRef = ref(null);
const isExportingPdf = ref(false);
const exportError = ref("");
const isExportingAnimationGif = ref(false);
const isExportingAnimationVideo = ref(false);
const animationExportError = ref("");
const animationWord = ref("");
const urlDrivenAnimationWord = ref("");
const isMobileViewport = ref(false);
const isAnimationModalVisible = ref(false);
const dismissedAnimationModalWord = ref("");
const supportedAnimationVideoFormat = ref(null);
const strokeDataByCharacter = shallowReactive({});
const pendingStrokeLoads = new Map();
const strokeAnimationTick = ref(0);
const animationMountElements = [];
const animationWriters = new Map();

let strokeAnimationTimer = 0;
let animationRenderToken = 0;
let animationLoopTimeout = 0;
let mobileViewportQuery = null;

onMounted(() => {
  mobileViewportQuery = window.matchMedia(`(max-width: ${mobileAnimationModalBreakpointPx}px)`);
  syncMobileViewport(mobileViewportQuery);
  supportedAnimationVideoFormat.value = getSupportedAnimationVideoFormat();

  strokeAnimationTimer = window.setInterval(() => {
    if (isExportingPdf.value) {
      return;
    }

    strokeAnimationTick.value += 1;
  }, strokeAnimationIntervalMs);

  syncAnimationWordFromUrl();
  window.addEventListener("keydown", handleWindowKeydown);
  mobileViewportQuery.addEventListener("change", syncMobileViewport);
  window.addEventListener("popstate", syncAnimationWordFromUrl);
});

onBeforeUnmount(() => {
  window.clearInterval(strokeAnimationTimer);
  document.body.style.overflow = "";
  window.removeEventListener("keydown", handleWindowKeydown);
  mobileViewportQuery?.removeEventListener("change", syncMobileViewport);
  window.removeEventListener("popstate", syncAnimationWordFromUrl);
  destroyAnimationWriters();
});

const normalizedRowsPerPage = computed(() =>
  clampNumber(rowsPerPage.value, 4, 14, defaults.rowsPerPage),
);

const normalizedTotalBoxes = computed(() =>
  clampNumber(totalBoxes.value, 6, 16, defaults.totalBoxes),
);

const normalizedTraceCopies = computed(() =>
  clampNumber(traceCopies.value, 0, normalizedTotalBoxes.value - 1, defaults.traceCopies),
);

const worksheetTitleDisplay = computed(() => {
  const trimmedTitle = worksheetTitle.value.trim();

  return trimmedTitle || defaults.title;
});

const footerTextDisplay = computed(() => footerText.value.trim());

const selectedWords = computed(() => parseWords(selectedWordsText.value));
const animationWordPinyin = computed(() => (animationWord.value ? safePinyin(animationWord.value) : ""));
const animationStrokeGuide = computed(() => strokeGuide(animationWord.value));
const shouldAutoShowAnimationModal = computed(
  () => isMobileViewport.value && Boolean(animationWord.value) && Boolean(urlDrivenAnimationWord.value),
);
const isExportingAnimation = computed(
  () => isExportingAnimationGif.value || isExportingAnimationVideo.value,
);
const animationVideoExportLabel = computed(() => {
  if (!supportedAnimationVideoFormat.value) {
    return "Video";
  }

  return supportedAnimationVideoFormat.value.extension.toUpperCase();
});
const animationVideoSupportCopy = computed(() => {
  if (!animationWord.value) {
    return "";
  }

  if (!supportedAnimationVideoFormat.value) {
    return "Video export is unavailable in this browser. GIF export is still available.";
  }

  if (supportedAnimationVideoFormat.value.extension !== "mp4") {
    return `This browser exports video as ${supportedAnimationVideoFormat.value.extension.toUpperCase()}.`;
  }

  return "";
});

watch(
  selectedWords,
  (words) => {
    void preloadStrokeData(words);
  },
  { immediate: true },
);

watch(
  animationWord,
  async (word) => {
    const renderToken = ++animationRenderToken;

    destroyAnimationWriters();
    animationMountElements.length = 0;

    if (!word) {
      return;
    }

    await preloadStrokeData([word]);

    if (renderToken !== animationRenderToken) {
      return;
    }

    await nextTick();

    if (renderToken !== animationRenderToken) {
      return;
    }

    renderAnimationWriters(word);
  },
  { immediate: true },
);

watch(
  shouldAutoShowAnimationModal,
  (shouldShow) => {
    if (!shouldShow) {
      dismissedAnimationModalWord.value = "";
      isAnimationModalVisible.value = false;
      return;
    }

    if (dismissedAnimationModalWord.value !== urlDrivenAnimationWord.value) {
      isAnimationModalVisible.value = true;
    }
  },
  { immediate: true },
);

watch(isAnimationModalVisible, (isVisible) => {
  document.body.style.overflow = isVisible ? "hidden" : "";
});

const selectedWordSet = computed(() => new Set(selectedWords.value));

const visibleWords = computed(() => {
  const filter = wordSearch.value.trim();

  if (!filter) {
    return defaultWords;
  }

  return defaultWords.filter((word) => word.includes(filter));
});

const pages = computed(() => paginate(selectedWords.value, normalizedRowsPerPage.value));

const selectionSummary = computed(() => {
  if (!selectedWords.value.length) {
    return "No words selected";
  }

  const pageCount = pages.value.length;
  const pageLabel = pageCount === 1 ? "page" : "pages";

  return `${selectedWords.value.length} words across ${pageCount} ${pageLabel}`;
});

function normalizeLayout() {
  rowsPerPage.value = String(normalizedRowsPerPage.value);
  totalBoxes.value = String(normalizedTotalBoxes.value);
  traceCopies.value = String(normalizedTraceCopies.value);
}

function syncMobileViewport(event) {
  isMobileViewport.value = event.matches;
}

function syncAnimationWordFromUrl() {
  const nextWord = getWordParamFromUrl();

  animationWord.value = nextWord;
  urlDrivenAnimationWord.value = nextWord;
}

function getWordParamFromUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  const [wordFromUrl = ""] = parseWords(searchParams.get("word") ?? "");

  return wordFromUrl;
}

function updateAnimationWord(value) {
  const [nextWord = ""] = parseWords(value);
  const url = new URL(window.location.href);

  animationExportError.value = "";
  urlDrivenAnimationWord.value = "";
  dismissedAnimationModalWord.value = "";

  if (nextWord) {
    url.searchParams.set("word", nextWord);
  } else {
    url.searchParams.delete("word");
  }

  window.history.replaceState({}, "", url);
  animationWord.value = nextWord;
}

function clearAnimationWord() {
  updateAnimationWord("");
}

function closeAnimationModal() {
  if (isExportingAnimation.value) {
    return;
  }

  dismissedAnimationModalWord.value = urlDrivenAnimationWord.value;
  isAnimationModalVisible.value = false;
}

function handleWindowKeydown(event) {
  if (event.key === "Escape" && isAnimationModalVisible.value) {
    closeAnimationModal();
  }
}

function useAllWords() {
  selectedWordsText.value = defaultWords.join("\n");
}

function cleanWords() {
  selectedWordsText.value = selectedWords.value.join("\n");
}

function clearWords() {
  selectedWordsText.value = "";
}

async function preloadStrokeData(words) {
  const loadTasks = [];

  for (const character of uniqueCharacters(words)) {
    loadTasks.push(loadStrokeData(character));
  }

  await Promise.allSettled(loadTasks);
}

function uniqueCharacters(words) {
  const characters = [];
  const seenCharacters = new Set();

  for (const word of words) {
    for (const character of Array.from(word)) {
      if (!character.trim() || seenCharacters.has(character)) {
        continue;
      }

      seenCharacters.add(character);
      characters.push(character);
    }
  }

  return characters;
}

function loadStrokeData(character) {
  if (character in strokeDataByCharacter) {
    return Promise.resolve(strokeDataByCharacter[character]);
  }

  if (pendingStrokeLoads.has(character)) {
    return pendingStrokeLoads.get(character);
  }

  const request = fetch(`${strokeDataBaseUrl}/${encodeURIComponent(character)}.json`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Unexpected response ${response.status}`);
      }

      const strokeData = await response.json();

      strokeDataByCharacter[character] = strokeData;
      return strokeDataByCharacter[character];
    })
    .catch(() => {
      strokeDataByCharacter[character] = null;
      return null;
    })
    .finally(() => {
      pendingStrokeLoads.delete(character);
    });

  pendingStrokeLoads.set(character, request);

  return request;
}

function toggleWord(word) {
  const nextWords = [...selectedWords.value];
  const wordIndex = nextWords.indexOf(word);

  if (wordIndex >= 0) {
    nextWords.splice(wordIndex, 1);
  } else {
    nextWords.push(word);
  }

  selectedWordsText.value = nextWords.join("\n");
}

function printWorksheet() {
  normalizeLayout();
  document.title = `${worksheetTitleDisplay.value} Worksheet`;
  window.print();
}

async function downloadPdf() {
  if (!selectedWords.value.length || !previewRef.value || isExportingPdf.value) {
    return;
  }

  normalizeLayout();
  exportError.value = "";
  isExportingPdf.value = true;

  const previousTitle = document.title;

  try {
    await nextTick();

    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);

    const pageElements = Array.from(previewRef.value.querySelectorAll(".worksheet-page"));

    if (!pageElements.length) {
      throw new Error("No worksheet pages available for export");
    }

    document.title = `${worksheetTitleDisplay.value} Worksheet`;

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true,
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();

    for (const [pageIndex, pageElement] of pageElements.entries()) {
      const canvas = await html2canvas(pageElement, {
        backgroundColor: "#ffffff",
        scale: 2,
        useCORS: true,
      });

      const imageData = canvas.toDataURL("image/png");

      if (pageIndex > 0) {
        pdf.addPage();
      }

      pdf.addImage(imageData, "PNG", 0, 0, pdfWidth, pdfHeight, undefined, "FAST");
    }

    pdf.save(`${buildFilename(worksheetTitleDisplay.value)}.pdf`);
  } catch (error) {
    console.error("Unable to generate PDF", error);
    exportError.value = "Unable to generate the PDF. Please try again.";
  } finally {
    document.title = previousTitle;
    isExportingPdf.value = false;
  }
}

async function downloadAnimationGif() {
  if (!animationWord.value || isExportingAnimation.value || isExportingPdf.value) {
    return;
  }

  isExportingAnimationGif.value = true;
  animationExportError.value = "";

  try {
    const gif = GIFEncoder();
    const { word } = await captureAnimationSequence((snapshotCanvas, frameIndex) => {
      const snapshotContext = snapshotCanvas.getContext("2d", { willReadFrequently: true });

      if (!snapshotContext) {
        throw new Error("Unable to read the animation export canvas");
      }

      const { data } = snapshotContext.getImageData(0, 0, snapshotCanvas.width, snapshotCanvas.height);
      const palette = quantize(data, animationExportPaletteSize);
      const indexedFrame = applyPalette(data, palette);

      gif.writeFrame(indexedFrame, snapshotCanvas.width, snapshotCanvas.height, {
        palette,
        delay: animationExportFrameDelayMs,
        ...(frameIndex === 0 ? { repeat: 0 } : {}),
      });
    });

    gif.finish();

    downloadBlob(
      new Blob([gif.bytes()], { type: "image/gif" }),
      buildAnimationExportFilename(word, "gif"),
    );
  } catch (error) {
    console.error("Unable to export animation GIF", error);
    animationExportError.value = "Unable to export the animation as a GIF. Please try again.";
  } finally {
    isExportingAnimationGif.value = false;
  }
}

async function downloadAnimationVideo() {
  if (
    !animationWord.value ||
    !supportedAnimationVideoFormat.value ||
    isExportingAnimation.value ||
    isExportingPdf.value
  ) {
    return;
  }

  isExportingAnimationVideo.value = true;
  animationExportError.value = "";

  let recording = null;

  try {
    const captureCanvas = document.createElement("canvas");
    let captureContext = null;

    const { word } = await captureAnimationSequence(async (snapshotCanvas) => {
      if (!captureContext) {
        captureCanvas.width = snapshotCanvas.width;
        captureCanvas.height = snapshotCanvas.height;
        captureContext = captureCanvas.getContext("2d");

        if (!captureContext) {
          throw new Error("Unable to start the animation recorder");
        }

        recording = createAnimationRecorder(captureCanvas, supportedAnimationVideoFormat.value);
      }

      captureContext.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
      captureContext.drawImage(snapshotCanvas, 0, 0);
    });

    if (!recording) {
      throw new Error("Animation recorder did not start");
    }

    const animationVideoBlob = await recording.stop();

    downloadBlob(
      animationVideoBlob,
      buildAnimationExportFilename(word, supportedAnimationVideoFormat.value.extension),
    );
  } catch (error) {
    console.error("Unable to export animation video", error);
    animationExportError.value = `Unable to export the animation as ${animationVideoExportLabel.value}. Please try again.`;

    if (recording) {
      recording.cancel();
    }
  } finally {
    isExportingAnimationVideo.value = false;
  }
}

async function captureAnimationSequence(onFrame) {
  const word = animationWord.value;

  if (!word) {
    throw new Error("Select a word before exporting the animation");
  }

  const exportScene = await createAnimationExportScene(word);
  let frameCount = 0;

  try {
    exportScene.renderFrame();
    await onFrame(exportScene.canvas, frameCount);
    frameCount += 1;

    const maxFrames = Math.max(
      2,
      Math.ceil(calculateAnimationExportDuration(word) / animationExportFrameDelayMs) + 4,
    );
    let animationCompleted = false;
    let animationError = null;
    const animationPromise = exportScene
      .startAnimation()
      .catch((error) => {
        animationError = error;
      })
      .finally(() => {
        animationCompleted = true;
      });

    while (!animationCompleted && frameCount < maxFrames) {
      await wait(animationExportFrameDelayMs);
      exportScene.renderFrame();
      await onFrame(exportScene.canvas, frameCount);
      frameCount += 1;
    }

    await animationPromise;

    if (animationError) {
      throw animationError;
    }

    for (let settleFrameIndex = 0; settleFrameIndex < 2; settleFrameIndex += 1) {
      await wait(animationExportFrameDelayMs);
      exportScene.renderFrame();
      await onFrame(exportScene.canvas, frameCount);
      frameCount += 1;
    }
  } finally {
    exportScene.cleanup();
  }

  return { frameCount, word };
}

async function createAnimationExportScene(word) {
  await preloadStrokeData([word]);

  const renderableCharacters = strokeGuide(word).filter((characterGuide) => characterGuide.steps.length);

  if (!renderableCharacters.length) {
    throw new Error(`No stroke data is available for ${word}`);
  }

  const previewBoxSize = getAnimationPreviewBoxSize();
  const boxSize = getAnimationExportBoxSize(previewBoxSize);
  const gap = getAnimationExportGap(previewBoxSize, boxSize);
  const padding = getAnimationExportPadding(boxSize);
  const scale = Math.min(window.devicePixelRatio || 1, animationExportMaxScale);
  const totalWidth = boxSize * renderableCharacters.length + gap * Math.max(0, renderableCharacters.length - 1);
  const exportRoot = document.createElement("div");
  const mounts = [];

  exportRoot.style.position = "fixed";
  exportRoot.style.left = "-10000px";
  exportRoot.style.top = "0";
  exportRoot.style.display = "flex";
  exportRoot.style.gap = `${gap}px`;
  exportRoot.style.pointerEvents = "none";
  exportRoot.style.opacity = "0";
  document.body.appendChild(exportRoot);

  for (const characterGuide of renderableCharacters) {
    const mountElement = document.createElement("div");

    mountElement.style.width = `${boxSize}px`;
    mountElement.style.height = `${boxSize}px`;
    exportRoot.appendChild(mountElement);
    mounts.push({ character: characterGuide.character, mountElement });
  }

  const writers = mounts.map(({ character, mountElement }) => {
    mountElement.replaceChildren();
    return HanziWriter.create(mountElement, character, getAnimationWriterOptions(boxSize, "canvas"));
  });
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(1, Math.round((totalWidth + padding * 2) * scale));
  exportCanvas.height = Math.max(1, Math.round((boxSize + padding * 2) * scale));

  await Promise.all(writers.map(waitForWriterReady));
  await Promise.all(writers.map((writer) => awaitHanziWriterAction(writer.hideCharacter({ duration: 0 }))));
  await waitForAnimationFrame();

  return {
    canvas: exportCanvas,
    cleanup() {
      for (const writer of writers) {
        if (typeof writer?.destroy === "function") {
          writer.destroy();
        }
      }

      exportRoot.remove();
    },
    renderFrame() {
      drawAnimationExportFrame(exportCanvas, mounts, boxSize, gap, padding, scale);
    },
    startAnimation() {
      return animateExportWriterSequence(writers, 0);
    },
  };
}

function getAnimationPreviewBoxSize() {
  const mountedSizes = animationMountElements
    .filter((element) => element instanceof HTMLElement)
    .map((element) => Math.floor(Math.min(element.clientWidth, element.clientHeight) || 0))
    .filter(Boolean);

  if (mountedSizes.length) {
    return Math.max(72, mountedSizes[0]);
  }

  return 84;
}

function getAnimationExportBoxSize(previewBoxSize) {
  const scaledBoxSize = Math.round(previewBoxSize * animationExportBoxSizeMultiplier);

  return Math.min(Math.max(scaledBoxSize, animationExportMinBoxSize), animationExportMaxBoxSize);
}

function getAnimationExportGap(previewBoxSize, exportBoxSize) {
  const previewBody = animationPreviewRef.value?.querySelector(".word-animation-panel__body");
  const sizeRatio = exportBoxSize / Math.max(previewBoxSize, 1);

  if (previewBody) {
    const computedGap = Number.parseFloat(window.getComputedStyle(previewBody).columnGap);

    if (Number.isFinite(computedGap)) {
      return Math.max(10, Math.round(computedGap * sizeRatio));
    }
  }

  return Math.max(10, Math.round(10 * sizeRatio));
}

function getAnimationExportPadding(boxSize) {
  const scaledPadding = Math.round(boxSize * animationExportPaddingRatio);

  return Math.min(Math.max(scaledPadding, animationExportMinPadding), animationExportMaxPadding);
}

function drawAnimationExportFrame(canvas, mounts, boxSize, gap, padding, scale) {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to draw the animation export");
  }

  const totalWidth = boxSize * mounts.length + gap * Math.max(0, mounts.length - 1);
  const totalHeight = boxSize + padding * 2;

  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, totalWidth + padding * 2, totalHeight);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, totalWidth + padding * 2, totalHeight);

  mounts.forEach(({ mountElement }, mountIndex) => {
    const x = padding + mountIndex * (boxSize + gap);
    const y = padding;
    const writerCanvas = mountElement.querySelector("canvas");

    drawAnimationExportBox(context, x, y, boxSize);

    if (writerCanvas instanceof HTMLCanvasElement) {
      context.drawImage(writerCanvas, x, y, boxSize, boxSize);
    }
  });
}

function drawAnimationExportBox(context, x, y, size) {
  context.save();
  context.beginPath();
  drawRoundedRectPath(context, x, y, size, size, 12);
  context.clip();
  context.fillStyle = "#fffdfa";
  context.fillRect(x, y, size, size);
  context.strokeStyle = "rgba(239, 102, 89, 0.18)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x + size / 2, y);
  context.lineTo(x + size / 2, y + size);
  context.moveTo(x, y + size / 2);
  context.lineTo(x + size, y + size / 2);
  context.stroke();
  context.restore();

  context.beginPath();
  drawRoundedRectPath(context, x + 0.5, y + 0.5, size - 1, size - 1, 12);
  context.strokeStyle = "rgba(239, 102, 89, 0.45)";
  context.lineWidth = 1;
  context.stroke();
}

function drawRoundedRectPath(context, x, y, width, height, radius) {
  const boundedRadius = Math.min(radius, width / 2, height / 2);

  context.moveTo(x + boundedRadius, y);
  context.arcTo(x + width, y, x + width, y + height, boundedRadius);
  context.arcTo(x + width, y + height, x, y + height, boundedRadius);
  context.arcTo(x, y + height, x, y, boundedRadius);
  context.arcTo(x, y, x + width, y, boundedRadius);
  context.closePath();
}

function animateExportWriterSequence(writers, index) {
  const writer = writers[index];

  if (!writer) {
    return wait(wordAnimationLoopDelayMs);
  }

  return awaitHanziWriterAction(writer.animateCharacter()).then(() => {
    return animateExportWriterSequence(writers, index + 1);
  });
}

function calculateAnimationExportDuration(word) {
  const characterGuides = strokeGuide(word);
  const totalStrokes = characterGuides.reduce((strokeCount, characterGuide) => {
    return strokeCount + characterGuide.steps.length;
  }, 0);
  const estimatedDuration = totalStrokes * 240 + characterGuides.length * 520 + wordAnimationLoopDelayMs;

  return Math.min(Math.max(estimatedDuration, 2_600), 8_200);
}

function getSupportedAnimationVideoFormat() {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return null;
  }

  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return animationVideoFormats[1];
  }

  for (const format of animationVideoFormats) {
    if (MediaRecorder.isTypeSupported(format.mimeType)) {
      return format;
    }
  }

  return null;
}

function createAnimationRecorder(canvas, format) {
  const stream = canvas.captureStream(Math.round(1000 / animationExportFrameDelayMs));
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: animationExportVideoBitsPerSecond,
  });
  const chunks = [];

  const animationVideoBlob = new Promise((resolve, reject) => {
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        chunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener(
      "stop",
      () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(new Blob(chunks, { type: format.mimeType }));
      },
      { once: true },
    );

    mediaRecorder.addEventListener(
      "error",
      (event) => {
        stream.getTracks().forEach((track) => track.stop());
        reject(event.error ?? new Error("Unable to record the animation"));
      },
      { once: true },
    );
  });

  mediaRecorder.start();

  return {
    cancel() {
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
        return;
      }

      stream.getTracks().forEach((track) => track.stop());
    },
    stop() {
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }

      return animationVideoBlob;
    },
  };
}

function buildAnimationExportFilename(word, extension) {
  return `${buildFilename(word)}-stroke-order.${extension}`;
}

function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);
}

function waitForAnimationFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function wait(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function practiceVariant(index) {
  if (index === 0) {
    return "practice-cell--model";
  }

  if (index <= normalizedTraceCopies.value) {
    return "practice-cell--trace";
  }

  return "practice-cell--blank";
}

function practiceCells(word) {
  const characters = Array.from(word).slice(0, normalizedTotalBoxes.value);

  if (!characters.length) {
    return [];
  }

  const copyWidth = characters.length;
  const maxCopies = Math.max(1, Math.floor(normalizedTotalBoxes.value / copyWidth));
  const visibleCopies = Math.max(1, Math.min(normalizedTraceCopies.value + 1, maxCopies));
  const cells = [];

  for (let copyIndex = 0; copyIndex < visibleCopies; copyIndex += 1) {
    const variant = practiceVariant(copyIndex);

    for (const character of characters) {
      cells.push({ text: character, variant });
    }
  }

  while (cells.length < normalizedTotalBoxes.value) {
    cells.push({ text: "", variant: "practice-cell--blank" });
  }

  return cells;
}

function safePinyin(word) {
  try {
    return pinyin(word, { toneType: "symbol" });
  } catch (error) {
    console.error("Unable to generate pinyin", error);
    return word;
  }
}

function paginate(items, pageSize) {
  const nextPages = [];

  for (let index = 0; index < items.length; index += pageSize) {
    nextPages.push(items.slice(index, index + pageSize));
  }

  return nextPages;
}

function parseWords(text) {
  const seenWords = new Set();

  return text
    .split(/[\n,，、;；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      if (seenWords.has(entry)) {
        return false;
      }

      seenWords.add(entry);
      return true;
    });
}

function clampNumber(value, min, max, fallback) {
  const parsedValue = Number.parseInt(value, 10);

  if (Number.isNaN(parsedValue)) {
    return fallback;
  }

  return Math.min(Math.max(parsedValue, min), max);
}

function buildFilename(value) {
  const sanitizedValue = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-");

  return sanitizedValue || "chinese-worksheet";
}

function strokeGuide(word) {
  return Array.from(word).map((character) => {
    const strokes = strokeDataByCharacter[character]?.strokes;

    return {
      character,
      steps: Array.isArray(strokes)
        ? strokes.map((_, strokeIndex) => strokes.slice(0, strokeIndex + 1))
        : [],
    };
  });
}

function setAnimationMountElement(index, element) {
  if (element) {
    animationMountElements[index] = element;
    return;
  }

  delete animationMountElements[index];
}

function destroyAnimationWriters() {
  window.clearTimeout(animationLoopTimeout);

  for (const writer of animationWriters.values()) {
    if (typeof writer?.destroy === "function") {
      writer.destroy();
    }
  }

  animationWriters.clear();
}

function renderAnimationWriters(word) {
  const characterGuides = strokeGuide(word);
  const writersForWord = [];
  const renderToken = animationRenderToken;

  for (const [characterIndex, characterGuide] of characterGuides.entries()) {
    const mountElement = animationMountElements[characterIndex];

    if (!mountElement || !characterGuide.steps.length) {
      continue;
    }

    mountElement.replaceChildren();

    const writerSize = Math.max(
      72,
      Math.floor(Math.min(mountElement.clientWidth, mountElement.clientHeight) || 84),
    );

    const writer = HanziWriter.create(
      mountElement,
      characterGuide.character,
      getAnimationWriterOptions(writerSize, "svg"),
    );

    animationWriters.set(characterIndex, writer);
    writersForWord.push(writer);
  }

  if (writersForWord.length) {
    void Promise.all(writersForWord.map(waitForWriterReady)).then(() => {
      if (animationRenderToken === renderToken) {
        startChainedAnimationLoop(renderToken);
      }
    });
  }
}

function getAnimationWriterOptions(writerSize, renderer) {
  return {
    width: writerSize,
    height: writerSize,
    padding: Math.round(writerSize * 0.08),
    showCharacter: false,
    showOutline: true,
    strokeAnimationSpeed: 1.2,
    delayBetweenStrokes: 180,
    delayBetweenLoops: 500,
    outlineColor: "#eadfd6",
    strokeColor: "#111111",
    radicalColor: "#b64028",
    renderer,
    charDataLoader: loadHanziWriterCharData,
  };
}

function waitForWriterReady(writer) {
  if (typeof writer?.getCharacterData !== "function") {
    return Promise.resolve();
  }

  return writer.getCharacterData().then(() => undefined).catch(() => undefined);
}

function startChainedAnimationLoop(renderToken) {
  const writers = Array.from(animationWriters.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, writer]) => writer);

  if (!writers.length || renderToken !== animationRenderToken) {
    return;
  }

  void animateWriterSequence(writers, 0, renderToken);
}

async function animateWriterSequence(writers, index, renderToken) {
  if (renderToken !== animationRenderToken) {
    return;
  }

  const writer = writers[index];

  if (!writer) {
    animationLoopTimeout = window.setTimeout(() => {
      startChainedAnimationLoop(renderToken);
    }, wordAnimationLoopDelayMs);
    return;
  }

  await awaitHanziWriterAction(writer.hideCharacter({ duration: 0 }));

  if (renderToken !== animationRenderToken) {
    return;
  }

  await awaitHanziWriterAction(writer.animateCharacter());

  if (renderToken !== animationRenderToken) {
    return;
  }

  await animateWriterSequence(writers, index + 1, renderToken);
}

async function awaitHanziWriterAction(actionResult) {
  const firstResult = await actionResult;

  if (firstResult && typeof firstResult.then === "function") {
    return firstResult;
  }

  return firstResult;
}

function loadHanziWriterCharData(character, onLoad, onError) {
  const cachedData = strokeDataByCharacter[character];

  if (cachedData) {
    onLoad(cachedData);
    return cachedData;
  }

  if (cachedData === null) {
    const error = new Error(`Unable to load stroke data for ${character}`);

    onError(error);
    throw error;
  }

  return loadStrokeData(character).then((loadedData) => {
    if (!loadedData) {
      const error = new Error(`Unable to load stroke data for ${character}`);

      onError(error);
      throw error;
    }

    onLoad(loadedData);
    return loadedData;
  });
}

function animatedStrokeStep(word, characterIndex, steps) {
  if (!steps.length) {
    return [];
  }

  if (steps.length === 1) {
    return steps[0];
  }

  const stepIndex = (strokeAnimationTick.value + strokeAnimationOffset(word, characterIndex)) % steps.length;

  return steps[stepIndex];
}

function strokeAnimationOffset(word, characterIndex) {
  let total = characterIndex;

  for (const character of Array.from(word)) {
    total += character.codePointAt(0) ?? 0;
  }

  return total;
}
</script>

<template>
  <div class="app-shell">
    <aside class="controls-panel">
      <div class="panel-hero">
        <p class="panel-kicker">Chinese learning tool</p>
        <h1>Worksheet generator</h1>
        <p class="panel-copy">
          Pick words from the source list, tune the page layout, and download a ready-made PDF.
        </p>
        <div class="panel-contact" aria-label="Contact information">
          <p class="panel-contact__label">Contact</p>
          <p class="panel-contact__name">Tr. Phoo Pwint Kyaw</p>
          <div class="panel-contact__links">
            <a
              class="panel-contact__link"
              href="mailto:phoopwintkyaw49@gmail.com"
              aria-label="Email Tr. Phoo Pwint Kyaw on Gmail"
            >
              <Icon :icon="googleGmail" aria-hidden="true" />
            </a>
            <a
              class="panel-contact__link"
              href="https://t.me/sebby_elgi"
              target="_blank"
              rel="noreferrer"
              aria-label="Open Telegram contact @sebby_elgi"
            >
              <Icon :icon="telegram" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <section class="panel-section">
        <label class="field-label" for="worksheetTitle">Worksheet title</label>
        <input
          id="worksheetTitle"
          v-model="worksheetTitle"
          class="text-input"
          type="text"
        />
      </section>

      <section class="panel-section">
        <label class="field-label" for="footerText">Footer text</label>
        <input
          id="footerText"
          v-model="footerText"
          class="text-input"
          type="text"
          placeholder="Enter footer text"
        />
      </section>

      <section class="panel-section panel-section--grid">
        <label class="field-group">
          <span class="field-label">Rows per page</span>
          <input
            v-model="rowsPerPage"
            class="text-input"
            type="number"
            min="4"
            max="14"
            @blur="normalizeLayout"
          />
        </label>

        <label class="field-group">
          <span class="field-label">Boxes per row</span>
          <input
            v-model="totalBoxes"
            class="text-input"
            type="number"
            min="6"
            max="16"
            @blur="normalizeLayout"
          />
        </label>

        <label class="field-group">
          <span class="field-label">Trace copies</span>
          <input
            v-model="traceCopies"
            class="text-input"
            type="number"
            min="0"
            max="15"
            @blur="normalizeLayout"
          />
        </label>

        <label class="checkbox-field">
          <input v-model="showPinyin" type="checkbox" />
          <span>Show pinyin</span>
        </label>
      </section>

      <section class="panel-section">
        <div class="section-heading">
          <div>
            <h2>Selected words</h2>
            <p>Edit directly. One word per line, or paste comma-separated text.</p>
          </div>
          <div class="button-row button-row--tight">
            <button type="button" class="secondary-button" @click="useAllWords">Use all</button>
            <button type="button" class="secondary-button" @click="cleanWords">Clean</button>
            <button type="button" class="secondary-button" @click="clearWords">Clear</button>
          </div>
        </div>
        <textarea
          v-model="selectedWordsText"
          class="words-input"
          spellcheck="false"
        ></textarea>
      </section>

      <section class="panel-section">
        <div class="section-heading">
          <div>
            <h2>Word bank</h2>
            <p>Loaded from words.txt. Click any item to add or remove it.</p>
          </div>
        </div>
        <input
          v-model="wordSearch"
          class="text-input"
          type="search"
          placeholder="Filter words"
        />
        <div class="word-bank">
          <p v-if="!visibleWords.length" class="empty-word-bank">No matching words.</p>
          <button
            v-for="word in visibleWords"
            :key="word"
            type="button"
            class="word-chip"
            :class="{ 'is-selected': selectedWordSet.has(word) }"
            @click="toggleWord(word)"
          >
            {{ word }}
          </button>
        </div>
      </section>
    </aside>

    <main class="workspace">
      <div
        v-if="isAnimationModalVisible"
        class="animation-modal-backdrop"
        aria-hidden="true"
        @click="closeAnimationModal"
      ></div>

      <section
        class="word-animation-panel"
        :class="{ 'word-animation-panel--modal': isAnimationModalVisible }"
        :aria-modal="isAnimationModalVisible ? 'true' : undefined"
        :role="isAnimationModalVisible ? 'dialog' : undefined"
      >
        <div class="word-animation-panel__header">
          <div class="word-animation-panel__meta">
            <p class="toolbar-kicker">Word animation</p>
            <p class="word-animation-panel__copy">
              Type a word here or open the page with a `word` URL parameter to preview stroke order and export it.
            </p>
            <p
              v-if="animationExportError"
              class="word-animation-panel__status word-animation-panel__status--error"
            >
              {{ animationExportError }}
            </p>
            <p v-else-if="animationVideoSupportCopy" class="word-animation-panel__status">
              {{ animationVideoSupportCopy }}
            </p>
          </div>
          <div class="word-animation-panel__controls">
            <input
              class="text-input word-animation-panel__input"
              :disabled="isExportingAnimation"
              type="text"
              :value="animationWord"
              placeholder="Enter a word to animate"
              @input="updateAnimationWord($event.target.value)"
            />
            <button
              v-if="animationWord"
              type="button"
              class="secondary-button"
              :disabled="isExportingAnimation || isExportingPdf"
              @click="downloadAnimationGif"
            >
              {{ isExportingAnimationGif ? "Preparing GIF..." : "Download GIF" }}
            </button>
            <button
              v-if="animationWord"
              type="button"
              class="secondary-button"
              :disabled="!supportedAnimationVideoFormat || isExportingAnimation || isExportingPdf"
              @click="downloadAnimationVideo"
            >
              {{
                isExportingAnimationVideo
                  ? `Preparing ${animationVideoExportLabel}...`
                  : `Download ${animationVideoExportLabel}`
              }}
            </button>
            <button
              v-if="animationWord"
              type="button"
              class="secondary-button"
              :disabled="isExportingAnimation"
              @click="clearAnimationWord"
            >
              Clear
            </button>
            <button
              v-if="isAnimationModalVisible"
              type="button"
              class="secondary-button"
              :disabled="isExportingAnimation"
              @click="closeAnimationModal"
            >
              Close
            </button>
          </div>
        </div>

        <div
          ref="animationPreviewRef"
          class="word-animation-panel__preview"
          :class="{ 'is-empty': !animationWord }"
        >
          <template v-if="animationWord">
            <div class="word-animation-panel__summary">
              <h2 class="word-animation-panel__word">{{ animationWord }}</h2>
              <p v-if="animationWordPinyin" class="word-animation-panel__pinyin">
                {{ animationWordPinyin }}
              </p>
            </div>

            <div class="word-animation-panel__body">
              <article
                v-for="(characterGuide, characterIndex) in animationStrokeGuide"
                :key="`animation-${animationWord}-${characterIndex}-${characterGuide.character}`"
                class="word-animation-card"
              >
                <div class="word-animation-card__header">
                  <p class="word-animation-card__character">{{ characterGuide.character }}</p>
                  <p class="word-animation-card__count">
                    {{ characterGuide.steps.length ? `${characterGuide.steps.length} strokes` : "Loading..." }}
                  </p>
                </div>

                <div
                  v-if="characterGuide.steps.length"
                  :ref="(element) => setAnimationMountElement(characterIndex, element)"
                  class="word-animation-card__canvas word-animation-card__canvas--writer"
                  aria-hidden="true"
                ></div>
                <div v-else class="word-animation-card__canvas" aria-hidden="true">
                  <span class="word-animation-card__fallback">{{ characterGuide.character }}</span>
                </div>
              </article>
            </div>
          </template>

          <p v-else class="word-animation-panel__empty">
            Enter a word above, or open this page with `?word=你好` to show its writing animation.
          </p>
        </div>
      </section>

      <div class="workspace-toolbar">
        <div>
          <p class="toolbar-kicker">Preview</p>
          <p class="selection-summary">{{ selectionSummary }}</p>
          <p v-if="exportError" class="export-error">{{ exportError }}</p>
        </div>
        <div class="button-row">
          <button
            type="button"
            class="primary-button"
            :disabled="!selectedWords.length || isExportingPdf"
            @click="downloadPdf"
          >
            {{ isExportingPdf ? "Preparing PDF..." : "Download PDF" }}
          </button>
        </div>
      </div>

      <div v-if="!selectedWords.length" class="preview">
        <section class="empty-state">
          <h2>Add some words</h2>
          <p>Select words from the bank or paste your own list to generate worksheet pages.</p>
        </section>
      </div>

      <div
        v-else
        ref="previewRef"
        class="preview"
        :class="{ 'preview--exporting': isExportingPdf }"
      >
        <section
          v-for="(pageWords, pageIndex) in pages"
          :key="`page-${pageIndex + 1}`"
          class="worksheet-page"
          :style="{ '--box-count': normalizedTotalBoxes }"
        >
          <header class="page-header">
            <p class="page-header__name">姓名：</p>
            <h2 class="page-header__title">{{ worksheetTitleDisplay }}</h2>
            <p class="page-header__page">第{{ pageIndex + 1 }}页，共{{ pages.length }}页</p>
          </header>

          <div class="page-rows">
            <article
              v-for="word in pageWords"
              :key="`${pageIndex}-${word}`"
              class="worksheet-row"
            >
              <div class="worksheet-row__meta">
                <p v-if="showPinyin" class="worksheet-row__pinyin">{{ safePinyin(word) }}</p>
                <div class="worksheet-row__stroke-guide" :aria-label="`Stroke order for ${word}`">
                  <div
                    v-for="(characterGuide, characterIndex) in strokeGuide(word)"
                    :key="`${word}-${characterIndex}-${characterGuide.character}`"
                    class="stroke-guide__character"
                  >
                    <span
                      v-if="characterGuide.steps.length && !isExportingPdf"
                      class="stroke-guide__animation"
                      aria-hidden="true"
                    >
                      <svg
                        class="stroke-guide__svg stroke-guide__svg--animation"
                        viewBox="0 0 1024 1024"
                        focusable="false"
                      >
                        <g transform="translate(0 900) scale(1 -1)">
                          <path
                            v-for="(strokePath, strokeIndex) in animatedStrokeStep(
                              word,
                              characterIndex,
                              characterGuide.steps,
                            )"
                            :key="`${word}-${characterIndex}-animated-${strokeIndex}`"
                            :d="strokePath"
                          />
                        </g>
                      </svg>
                    </span>
                    <template v-if="characterGuide.steps.length">
                      <span
                        v-for="(step, stepIndex) in characterGuide.steps"
                        :key="`${word}-${characterIndex}-${stepIndex}`"
                        class="stroke-guide__step"
                        aria-hidden="true"
                      >
                        <svg
                          class="stroke-guide__svg"
                          viewBox="0 0 1024 1024"
                          focusable="false"
                        >
                          <g transform="translate(0 900) scale(1 -1)">
                            <path
                              v-for="(strokePath, strokeIndex) in step"
                              :key="`${word}-${characterIndex}-${stepIndex}-${strokeIndex}`"
                              :d="strokePath"
                            />
                          </g>
                        </svg>
                      </span>
                    </template>
                    <span v-else class="stroke-guide__fallback">{{ characterGuide.character }}</span>
                  </div>
                </div>
              </div>

              <div class="practice-strip">
                <div
                  v-for="(cell, boxIndex) in practiceCells(word)"
                  :key="`${word}-${boxIndex}`"
                  class="practice-cell"
                  :class="cell.variant"
                >
                  <span class="practice-cell__guides" aria-hidden="true">
                    <span class="practice-cell__guide practice-cell__guide--vertical"></span>
                    <span class="practice-cell__guide practice-cell__guide--horizontal"></span>
                    <span class="practice-cell__guide practice-cell__guide--diagonal"></span>
                  </span>
                  <span class="practice-cell__text">{{ cell.text }}</span>
                </div>
              </div>
            </article>
          </div>

          <footer v-if="footerTextDisplay" class="page-footer">{{ footerTextDisplay }}</footer>
        </section>
      </div>
    </main>
  </div>
</template>