<script setup>
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
const isExportingPdf = ref(false);
const exportError = ref("");
const animationWord = ref("");
const strokeDataByCharacter = shallowReactive({});
const pendingStrokeLoads = new Map();
const strokeAnimationTick = ref(0);
const animationMountElements = [];
const animationWriters = new Map();

let strokeAnimationTimer = 0;
let animationRenderToken = 0;
let animationLoopTimeout = 0;

onMounted(() => {
  strokeAnimationTimer = window.setInterval(() => {
    if (isExportingPdf.value) {
      return;
    }

    strokeAnimationTick.value += 1;
  }, strokeAnimationIntervalMs);

  syncAnimationWordFromUrl();
  window.addEventListener("popstate", syncAnimationWordFromUrl);
});

onBeforeUnmount(() => {
  window.clearInterval(strokeAnimationTimer);
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

function syncAnimationWordFromUrl() {
  animationWord.value = getWordParamFromUrl();
}

function getWordParamFromUrl() {
  const searchParams = new URLSearchParams(window.location.search);
  const [wordFromUrl = ""] = parseWords(searchParams.get("word") ?? "");

  return wordFromUrl;
}

function updateAnimationWord(value) {
  const [nextWord = ""] = parseWords(value);
  const url = new URL(window.location.href);

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

    const writer = HanziWriter.create(mountElement, characterGuide.character, {
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
      charDataLoader: loadHanziWriterCharData,
    });

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
      <section class="word-animation-panel">
        <div class="word-animation-panel__header">
          <div>
            <p class="toolbar-kicker">Word animation</p>
            <p class="word-animation-panel__copy">
              Type a word here or open the page with a `word` URL parameter to preview stroke order.
            </p>
          </div>
          <div class="word-animation-panel__controls">
            <input
              class="text-input word-animation-panel__input"
              type="text"
              :value="animationWord"
              placeholder="Enter a word to animate"
              @input="updateAnimationWord($event.target.value)"
            />
            <button
              v-if="animationWord"
              type="button"
              class="secondary-button"
              @click="clearAnimationWord"
            >
              Clear
            </button>
          </div>
        </div>

        <div class="word-animation-panel__preview" :class="{ 'is-empty': !animationWord }">
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