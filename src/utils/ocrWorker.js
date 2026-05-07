/**
 * Shared Tesseract worker.
 *
 * Why a shared worker?
 *  - Booting Tesseract.js loads ~10 MB of WASM + traineddata; doing that on
 *    every request blocks the event loop for 1–3 seconds.
 *  - A single long-lived worker handles requests serially (Tesseract isn't
 *    thread-safe per-worker anyway) and we serialise calls with a tiny queue
 *    so concurrent uploads don't corrupt each other.
 *
 * Why PSM 6?
 *  - Page-segmentation-mode 6 ("Assume a single uniform block of text") is the
 *    sweet spot for milk-bill-style tables. The default PSM 3 ("auto") often
 *    interleaves columns into the wrong reading order on phone photos.
 *
 * Returns: { text, words, confidence }  where words include bbox + confidence.
 * On failure: throws — callers must decide how to surface the error.
 */
const Tesseract = require('tesseract.js');

let workerPromise = null;
let pending = Promise.resolve(); // serialises recognize() calls

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // tesseract.js v7 createWorker is async and accepts language(s) directly.
      const worker = await Tesseract.createWorker('eng');
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM ? Tesseract.PSM.SINGLE_BLOCK : '6',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      // Reset so the next call retries instead of getting a permanently-rejected promise.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Recognise an image. Serialised to one-at-a-time on the shared worker.
 * @param {string|Buffer} input - file path or buffer
 * @returns {Promise<{text:string, words:Array, confidence:number}>}
 */
async function recognise(input) {
  // Chain onto the pending queue so concurrent calls don't race.
  const run = async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(input);
    return {
      text: data?.text || '',
      // tesseract.js exposes words with bbox + confidence
      words: Array.isArray(data?.words) ? data.words : [],
      confidence: typeof data?.confidence === 'number' ? data.confidence : 0,
    };
  };
  const next = pending.then(run, run); // run even if previous failed
  // Keep the queue alive but don't propagate this call's rejection to the queue.
  pending = next.catch(() => {});
  return next;
}

/**
 * Graceful shutdown — call from server shutdown hooks if desired.
 */
async function terminate() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch (_) {
    // ignore
  } finally {
    workerPromise = null;
  }
}

module.exports = { recognise, terminate };
