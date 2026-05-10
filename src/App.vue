<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, watch } from "vue";
import { pinyin } from "pinyin-pro";
import defaultWordsText from "../words.txt?raw";

const strokeDataBaseUrl = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1";
const strokeAnimationIntervalMs = 700;

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
const strokeDataByCharacter = shallowReactive({});
const pendingStrokeLoads = new Map();
const strokeAnimationTick = ref(0);

let strokeAnimationTimer = 0;

onMounted(() => {
  strokeAnimationTimer = window.setInterval(() => {
    if (isExportingPdf.value) {
      return;
    }

    strokeAnimationTick.value += 1;
  }, strokeAnimationIntervalMs);
});

onBeforeUnmount(() => {
  window.clearInterval(strokeAnimationTimer);
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

watch(
  selectedWords,
  (words) => {
    void preloadStrokeData(words);
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

      strokeDataByCharacter[character] = buildCharacterStrokeGuide(strokeData);
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

function buildCharacterStrokeGuide(strokeData) {
  const strokes = Array.isArray(strokeData?.strokes) ? strokeData.strokes : [];

  return {
    steps: strokes.map((_, strokeIndex) => strokes.slice(0, strokeIndex + 1)),
  };
}

function strokeGuide(word) {
  return Array.from(word).map((character) => {
    const characterGuide = strokeDataByCharacter[character];

    return {
      character,
      steps: characterGuide?.steps ?? [],
    };
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
          <a class="panel-contact__link" href="mailto:phoopwintkyaw49@gmail.com">
            phoopwintkyaw49@gmail.com
          </a>
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