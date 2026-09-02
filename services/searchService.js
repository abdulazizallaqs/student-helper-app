/**
 * Search ranking - the "make it semantic" half of /search-files.
 *
 * The old search was a single statement:
 *
 *     WHERE title LIKE '%q%' OR description LIKE '%q%' OR username LIKE '%q%'
 *
 * which means the whole query had to appear, character for character, inside
 * one field. "thermodynamics notes" found nothing unless a file was literally
 * called that. "Physics" never found a file tagged "فيزياء". "thermodyanmics"
 * (one typo) found nothing at all. And whatever did come back arrived in
 * primary-key order, so the best match could be last.
 *
 * This module fixes that WITHOUT spending any AI quota - no embeddings, no
 * per-query model call, nothing that can be rate-limited or go down. It does
 * four things a plain LIKE cannot:
 *
 *   1. Normalises text.  Case, punctuation, Arabic diacritics, tatweel and
 *      the alef/ya/ta-marbuta spelling variants are folded away, so "الفيزياء"
 *      and "فيزياء" and "الفيزيــاء" are the same word.
 *   2. Splits the query into terms and matches them independently, so word
 *      order and extra words stop mattering.
 *   3. Expands each term with light stemming and a bilingual study-domain
 *      thesaurus, so "maths" hits "mathematics", "ملخصات" hits "ملخص", and
 *      "physics" hits a file whose category is "فيزياء". This cross-language
 *      link is what makes the search feel semantic on a bilingual site.
 *   4. Scores and ranks. A hit in the title outweighs a hit buried in a
 *      description; matching every term outweighs matching one; an exact word
 *      outweighs a synonym, which outweighs a fuzzy (typo) match.
 *
 * Everything here is pure and synchronous so it can be unit-tested without a
 * database.
 */

// --- normalisation -------------------------------------------------------

// Harakat, tanween, superscript alef, tatweel: decoration that changes the
// bytes without changing the word.
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const BIDI_MARKS = /[\u200B-\u200F\u202A-\u202E]/g;

/**
 * Fold a string down to comparable words: lowercase, no diacritics, no
 * punctuation, single-spaced.
 * @param {*} value
 * @returns {string}
 */
export function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(BIDI_MARKS, '')
        .replace(ARABIC_MARKS, '')
        .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
        .replace(/ى/g, 'ي')                     // ى -> ي
        .replace(/ئ/g, 'ي')                     // ئ -> ي
        .replace(/ؤ/g, 'و')                     // ؤ -> و
        .replace(/ة/g, 'ه')                     // ة -> ه
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Words too common to carry meaning - dropped from the QUERY, never from the
 * text being searched.
 *
 * The question words matter more than they look. Now that a query can be a
 * whole sentence ("how do plants make food"), the function words in it are
 * live search terms unless they are removed - and "how" appears in a great
 * many descriptions, so a question about plants was matching a file about
 * volcanoes purely because that file's description contained the word "how".
 */
const STOP_WORDS = new Set([
    // articles, prepositions, conjunctions, auxiliaries
    'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'at', 'is',
    'are', 'was', 'were', 'be', 'been', 'with', 'about', 'from', 'by', 'as',
    'if', 'so', 'than', 'then', 'there', 'here', 'into', 'over', 'that',
    'this', 'these', 'those', 'it', 'its',
    // question words and the verbs that carry them
    'how', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why',
    'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will',
    // things people say to a search box
    'file', 'files', 'please', 'find', 'show', 'search', 'looking', 'need',
    'want', 'me', 'my', 'i', 'we', 'you', 'any', 'all', 'some',
    // Arabic equivalents (pre-normalised: no hamza, no ta-marbuta)
    'في', 'من', 'على', 'عن', 'الى', 'او', 'و', 'ما', 'هل', 'اي', 'هذا', 'هذه',
    'كيف', 'ليش', 'لماذا', 'متي', 'وين', 'اين', 'وش', 'شنو', 'اللي', 'الذي',
    'التي', 'عشان', 'يعني', 'هو', 'هي',
    'ملف', 'ملفات', 'ابحث', 'اريد', 'عايز', 'ابغي', 'ودي'
]);

/**
 * Crude but safe stemmer: only ever shortens a word, never rewrites it into a
 * different one. Aggressive stemming on a two-language corpus does more harm
 * than good, so this stops at the endings that are unambiguous.
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
    let w = word;
    if (/^[\u0600-\u06FF]/.test(w)) {
        // Arabic: the definite article and the common plural/possessive tails.
        w = w.replace(/^(وال|فال|بال|كال|ال)(?=.{3,})/, '');
        w = w.replace(/(?<=.{3})(ات|ون|ين|يه|ها|هم|هن|كم|نا)$/, '');
        return w;
    }
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && /(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
}

// --- thesaurus -----------------------------------------------------------

/**
 * Study-domain synonym groups, deliberately bilingual: every word in a group
 * is treated as a match for every other word in it, so an English query finds
 * Arabic material and vice versa. All entries are written pre-normalised
 * (no hamza, no ta-marbuta) because that is the form they are looked up in.
 */
const SYNONYM_GROUPS = [
    ['math', 'maths', 'mathematics', 'algebra', 'calculus', 'رياضيات', 'جبر', 'تفاضل', 'تكامل', 'حساب'],
    ['physics', 'mechanics', 'فيزياء', 'ميكانيكا'],
    ['chemistry', 'chem', 'كيمياء'],
    ['biology', 'bio', 'احياء', 'بيولوجيا'],
    ['computer', 'computing', 'programming', 'coding', 'software', 'حاسب', 'حاسوب', 'كمبيوتر', 'برمجه', 'برمجيات'],
    ['algorithm', 'algorithms', 'خوارزميات', 'خوارزم'],
    ['database', 'databases', 'sql', 'قواعد'],
    ['network', 'networks', 'networking', 'شبكات', 'شبكه'],
    ['ai', 'ml', 'ذكاء', 'اصطناعي'],
    ['english', 'انجليزي', 'انجليزيه'],
    ['arabic', 'عربي', 'عربيه'],
    ['history', 'تاريخ'],
    ['geography', 'جغرافيا'],
    ['engineering', 'هندسه', 'هندسي'],
    ['medicine', 'medical', 'طب', 'طبي'],
    ['statistics', 'stats', 'probability', 'احصاء', 'احتمالات'],
    ['economics', 'economy', 'اقتصاد'],
    ['accounting', 'محاسبه'],
    ['notes', 'note', 'summary', 'summaries', 'revision', 'ملخص', 'ملخصات', 'مذكره', 'مذكرات', 'ملاحظات', 'مراجعه'],
    ['exam', 'exams', 'test', 'tests', 'quiz', 'midterm', 'final', 'اختبار', 'اختبارات', 'امتحان', 'امتحانات', 'كويز'],
    ['homework', 'assignment', 'assignments', 'hw', 'واجب', 'واجبات', 'تكليف'],
    ['lecture', 'lectures', 'slides', 'presentation', 'محاضره', 'محاضرات', 'شرائح', 'عرض'],
    ['book', 'textbook', 'chapter', 'كتاب', 'كتب', 'فصل', 'مرجع'],
    ['solution', 'solutions', 'answer', 'answers', 'حل', 'حلول', 'اجابه', 'اجابات'],
    ['project', 'report', 'مشروع', 'تقرير'],
    ['lab', 'laboratory', 'practical', 'معمل', 'مختبر', 'عملي'],
    ['course', 'subject', 'module', 'ماده', 'مقرر', 'كورس'],
    ['introduction', 'basics', 'fundamentals', 'مقدمه', 'اساسيات', 'مبادئ']
];

const THESAURUS = new Map();
for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
        const key = normalize(word);
        const bucket = THESAURUS.get(key) || new Set();
        group.forEach((other) => { if (normalize(other) !== key) bucket.add(normalize(other)); });
        THESAURUS.set(key, bucket);
    }
}

// A second index keyed by stem, so "\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0627\u062a" (the definite article plus a plural)
// still reaches the group that only lists "\u0631\u064a\u0627\u0636\u064a\u0627\u062a".
const STEM_INDEX = new Map();
for (const [word, bucket] of THESAURUS) {
    const key = stem(word);
    if (!STEM_INDEX.has(key)) STEM_INDEX.set(key, new Set());
    const target = STEM_INDEX.get(key);
    target.add(word);
    bucket.forEach((entry) => target.add(entry));
}

/**
 * @param {string} word - already normalised
 * @returns {string[]}
 */
export function synonymsFor(word) {
    for (const key of [word, word.replace(/^(وال|فال|بال|كال|ال)(?=.{3,})/, ''), stem(word)]) {
        const bucket = THESAURUS.get(key) || STEM_INDEX.get(stem(key));
        if (bucket) return [...bucket].filter((entry) => entry !== word);
    }
    return [];
}

// --- query parsing -------------------------------------------------------

const MAX_TERMS = 8;
const MAX_VARIANTS_PER_TERM = 8;
const MAX_LIKE_PATTERNS = 48;

/**
 * Turn a raw search box value into the terms the rest of the module works on.
 *
 * @param {string} raw
 * @returns {{raw:string, normalized:string, phrase:string, terms:Array<{word:string, variants:string[]}>}}
 */
export function parseQuery(raw) {
    const normalized = normalize(raw);
    const words = normalized.split(' ').filter(Boolean);
    // Stop words are dropped - unless that would leave nothing, in which case
    // the user really did search for "the", and an empty result is worse than
    // a literal one.
    const meaningful = words.filter((word) => !STOP_WORDS.has(word));
    const chosen = (meaningful.length ? meaningful : words).slice(0, MAX_TERMS);

    const terms = chosen.map((word) => {
        const variants = new Set([word]);
        const stemmed = stem(word);
        if (stemmed && stemmed.length >= 2) variants.add(stemmed);
        for (const synonym of synonymsFor(word)) {
            if (variants.size >= MAX_VARIANTS_PER_TERM) break;
            variants.add(synonym);
        }
        return { word, stem: stemmed, variants: [...variants] };
    });

    return { raw: String(raw ?? ''), normalized, phrase: words.length > 1 ? normalized : '', terms };
}

/**
 * The LIKE patterns to hand to SQL. Deliberately generous: this is only the
 * candidate net, scoring decides what actually comes back and in what order.
 * @param {object} parsed - from parseQuery
 * @returns {string[]}
 */
export function likePatterns(parsed) {
    const patterns = new Set();
    for (const term of parsed.terms) {
        for (const variant of term.variants) {
            if (variant.length < 2) continue;
            if (patterns.size >= MAX_LIKE_PATTERNS) break;
            patterns.add(`%${variant}%`);
        }
    }
    if (patterns.size === 0 && parsed.normalized) patterns.add(`%${parsed.normalized}%`);
    return [...patterns];
}

// --- fuzzy matching ------------------------------------------------------

/**
 * Levenshtein distance, bounded so a pathological input cannot cost anything.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
    if (a === b) return 0;
    if (a.length > 32 || b.length > 32) return Math.abs(a.length - b.length) + 32;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        }
        previous = current;
    }
    return previous[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a, b) {
    const longest = Math.max(a.length, b.length);
    if (!longest) return 1;
    return 1 - editDistance(a, b) / longest;
}

// A typo is a typo; a different short word is a different word. Below five
// characters, one edit is usually a real distinction ("lab" vs "law"), so
// fuzzy matching only kicks in for longer terms - and even then it is capped
// by an absolute number of edits rather than a percentage. A percentage alone
// scales with word length in exactly the wrong way: at 78% similarity a
// fourteen-letter word tolerates three edits, which is enough for
// "chromodynamics" to be accepted as a misspelling of "thermodynamics".
const FUZZY_MIN_LENGTH = 5;

/**
 * How many single-character edits still count as "the same word, mistyped".
 * @param {string} word
 * @returns {number}
 */
function maxEditsFor(word) {
    if (word.length >= 9) return 2;
    if (word.length >= 6) return 1;
    return 0;
}

// --- scoring -------------------------------------------------------------

/**
 * Uploads store the AI-generated keywords inside the description, appended as
 * " | Keywords: ...". They are the closest thing the app has to a semantic
 * index, so they are pulled out and weighted above ordinary description prose.
 * @param {string} description
 * @returns {{body:string, keywords:string}}
 */
export function splitDescription(description) {
    const text = String(description ?? '');
    const match = text.match(/\|\s*keywords\s*:/i);
    if (!match || match.index === undefined) return { body: text, keywords: '' };
    return {
        body: text.slice(0, match.index).trim(),
        keywords: text.slice(match.index + match[0].length).trim()
    };
}

const FIELD_WEIGHT = { title: 34, category: 22, keywords: 16, description: 11, username: 8 };
const KIND_WEIGHT = { exact: 1, variant: 0.62, fuzzy: 0.42 };

function fieldsOf(file) {
    const { body, keywords } = splitDescription(file.description);
    return {
        title: normalize(file.title),
        category: normalize(file.category),
        keywords: normalize(keywords),
        description: normalize(body),
        username: normalize(file.username || file.uploader)
    };
}

/**
 * How well one term matches one field.
 * @returns {{score:number, kind:string}|null}
 */
function matchTermInField(term, field) {
    if (!field) return null;
    const words = field.split(' ');

    // Whole word beats "happens to be inside another word": searching "art"
    // should not rank a file about "particles" above one about art.
    if (words.includes(term.word)) return { score: KIND_WEIGHT.exact, kind: 'exact' };
    if (field.includes(term.word)) return { score: KIND_WEIGHT.exact * 0.7, kind: 'exact' };

    for (const variant of term.variants) {
        if (variant === term.word) continue;
        if (words.includes(variant)) return { score: KIND_WEIGHT.variant, kind: 'variant' };
        if (variant.length >= 4 && field.includes(variant)) {
            return { score: KIND_WEIGHT.variant * 0.7, kind: 'variant' };
        }
    }

    const allowedEdits = term.word.length >= FUZZY_MIN_LENGTH ? maxEditsFor(term.word) : 0;
    if (allowedEdits > 0) {
        let best = 0;
        for (const word of words) {
            if (Math.abs(word.length - term.word.length) > allowedEdits) continue;
            if (editDistance(term.word, word) > allowedEdits) continue;
            const score = similarity(term.word, word);
            if (score > best) best = score;
        }
        if (best > 0) return { score: KIND_WEIGHT.fuzzy * best, kind: 'fuzzy' };
    }

    return null;
}

// --- inverse document frequency ------------------------------------------

/**
 * How much each term is worth.
 *
 * Without this, every word of a query counts the same, and on a study-notes
 * site that is actively wrong: "notes" appears in half the library, so
 * matching it says almost nothing, while "carnot" appears in one file and
 * says almost everything. Searching "thermodynamics notes" used to be able to
 * rank a file called "Biology Notes" alongside the one the student wanted.
 *
 * The document frequencies are exact rather than estimated: the candidate set
 * this is measured over is, by construction, every file containing any form of
 * any query term, so a term's frequency inside it IS its frequency in the
 * library.
 *
 * @param {Array<object>} files - the candidate rows
 * @param {object} parsed - from parseQuery
 * @param {number} corpusSize - total files in the library
 * @returns {Map<string, number>} term -> multiplier, roughly 0.4 (everywhere) to 1.6 (unique)
 */
export function inverseDocumentFrequency(files, parsed, corpusSize) {
    const total = Math.max(corpusSize || 0, files.length, 1);
    const weights = new Map();

    for (const term of parsed.terms) {
        let df = 0;
        for (const file of files) {
            const fields = file.__fields || (file.__fields = fieldsOf(file));
            const hit = Object.values(fields).some((field) => matchTermInField(term, field));
            if (hit) df += 1;
        }
        const rarity = Math.log((total + 1) / (df + 1)) / Math.log(total + 1);
        weights.set(term.word, 0.4 + 1.2 * Math.max(0, Math.min(1, rarity)));
    }
    return weights;
}

// --- proximity -----------------------------------------------------------

const PROXIMITY_WINDOW = 4;
const PROXIMITY_MAX_BONUS = 26;

/**
 * Reward query terms that appear NEAR each other.
 *
 * "linear algebra" should prefer a file titled "Linear Algebra" over one whose
 * title mentions linear equations and whose description happens to mention
 * algebra thirty words later. Both match every term; only one is about the
 * thing that was asked for.
 *
 * @param {object} fields
 * @param {object} parsed
 * @returns {number}
 */
export function proximityBonus(fields, parsed) {
    if (parsed.terms.length < 2) return 0;

    // Title and keywords are where adjacency actually means something; a
    // description is prose and near-misses there are coincidence.
    const haystack = `${fields.title} ${fields.keywords}`.trim();
    if (!haystack) return 0;
    const words = haystack.split(' ');

    const positions = new Map();
    words.forEach((word, index) => {
        for (const term of parsed.terms) {
            if (word === term.word || term.variants.includes(word)) {
                if (!positions.has(term.word)) positions.set(term.word, []);
                positions.get(term.word).push(index);
            }
        }
    });
    if (positions.size < 2) return 0;

    let bonus = 0;
    const terms = [...positions.keys()];
    for (let i = 0; i < terms.length; i += 1) {
        for (let j = i + 1; j < terms.length; j += 1) {
            let closest = Infinity;
            for (const a of positions.get(terms[i])) {
                for (const b of positions.get(terms[j])) {
                    closest = Math.min(closest, Math.abs(a - b));
                }
            }
            if (closest <= PROXIMITY_WINDOW) {
                bonus += (PROXIMITY_WINDOW + 1 - closest) * 3;
            }
        }
    }
    return Math.min(PROXIMITY_MAX_BONUS, bonus);
}

// --- scoring -------------------------------------------------------------

/**
 * Score one file against a parsed query, on words alone.
 *
 * @param {object} file - a row from File.search's candidate query
 * @param {object} parsed - from parseQuery
 * @param {Map<string, number>} [idf] - term weights from inverseDocumentFrequency
 * @returns {{score:number, matched:string[], kinds:string[]}}
 */
export function scoreFile(file, parsed, idf) {
    const fields = file.__fields || (file.__fields = fieldsOf(file));
    const matched = [];
    const kinds = new Set();
    let score = 0;

    for (const term of parsed.terms) {
        const weight = idf ? (idf.get(term.word) ?? 1) : 1;
        let termScore = 0;
        for (const [name, fieldWeight] of Object.entries(FIELD_WEIGHT)) {
            const hit = matchTermInField(term, fields[name]);
            if (!hit) continue;
            kinds.add(hit.kind);
            // A term that appears in several fields is stronger than one that
            // appears in a single field, but not additively so - otherwise a
            // file that repeats its title in its description wins everything.
            termScore = Math.max(termScore, hit.score * fieldWeight) + hit.score * fieldWeight * 0.25;
        }
        if (termScore > 0) {
            matched.push(term.word);
            score += termScore * weight;
        }
    }

    if (matched.length === 0) return { score: 0, matched: [], kinds: [] };

    // Coverage: matching every word of the query is what the user meant.
    const coverage = matched.length / parsed.terms.length;
    score += coverage * 30;
    if (coverage === 1 && parsed.terms.length > 1) score += 25;

    score += proximityBonus(fields, parsed);

    // The full phrase, in order, in the title is as good as a search gets.
    if (parsed.phrase) {
        if (fields.title.includes(parsed.phrase)) score += 70;
        else if (fields.keywords.includes(parsed.phrase) || fields.description.includes(parsed.phrase)) score += 25;
    }

    return { score: Math.round(score * 100) / 100, matched, kinds: [...kinds] };
}

// --- blending words with meaning -----------------------------------------

// Cosine similarity below this is noise - unrelated study material still sits
// around 0.4-0.5 simply because it is all study material in the same language.
const SEMANTIC_FLOOR = 0.55;

// A file reached ONLY by meaning needs to clear this to be shown at all.
//
// Deliberately on the strict side. The two failure modes are not symmetrical:
// a semantic match that is missed is invisible - the student sees the keyword
// results they would have got anyway - while one that is wrong is a file with
// no apparent connection to the query sitting in the results, which reads as a
// broken search. Tunable for anyone who wants to trade one for the other.
const SEMANTIC_ADMIT = Math.min(0.99, Math.max(0.5,
    parseFloat(process.env.SEARCH_SEMANTIC_MIN || '0.72')));

// How many points a perfect semantic match is worth, next to the ~100 a
// perfect keyword match earns. Keeping it below 100 is deliberate: when a
// student types an exact title they want that file first, not a file the model
// considers conceptually adjacent.
const SEMANTIC_WEIGHT = 70;

/**
 * Squash an open-ended keyword score into 0..1 without needing to know what
 * the best score in the result set is (which would make one file's rank depend
 * on which other files happened to match).
 */
function saturate(score) {
    return score / (score + 70);
}

/**
 * Fold a cosine similarity into points.
 * @param {number} similarity
 * @returns {number}
 */
export function semanticPoints(similarity) {
    if (!Number.isFinite(similarity) || similarity <= SEMANTIC_FLOOR) return 0;
    return SEMANTIC_WEIGHT * ((similarity - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR));
}

/**
 * Rank candidate rows and drop the ones that only matched noise.
 *
 * @param {Array<object>} files - rows; may carry `_vector` (their embedding)
 * @param {string} query
 * @param {Object} [options]
 * @param {number} [options.limit=60]
 * @param {number} [options.minScore=1]
 * @param {number} [options.corpusSize] - total files, for IDF
 * @param {number[]} [options.queryVector] - the query's embedding, when available
 * @param {function} [options.cosine] - similarity function (injected so this
 *   module stays free of any dependency on the AI service)
 * @returns {Array<object>} the same rows, best first, each with _score/_matched
 */
export function rankFiles(files, query, options = {}) {
    const limit = options.limit ?? 60;
    const minScore = options.minScore ?? 1;
    const parsed = parseQuery(query);
    if (!parsed.terms.length) return [];

    const candidates = files || [];
    for (const file of candidates) delete file.__fields;

    const idf = inverseDocumentFrequency(candidates, parsed, options.corpusSize);
    const queryVector = options.queryVector;
    const similarityOf = options.cosine;
    const useSemantics = Boolean(queryVector && typeof similarityOf === 'function');

    const scored = candidates.map((file) => {
        const { score, matched, kinds } = scoreFile(file, parsed, idf);

        let similarity = 0;
        if (useSemantics && Array.isArray(file._vector)) {
            similarity = similarityOf(queryVector, file._vector);
        }
        const semantic = semanticPoints(similarity);
        const lexical = 100 * saturate(score);

        return {
            file, matched, kinds, similarity,
            keywordScore: score,
            total: Math.round((lexical + semantic) * 100) / 100
        };
    });

    return scored
        // A row earns its place either by words or by meaning. The second half
        // of this condition is the whole point of embeddings: it lets in a file
        // that shares no vocabulary at all with what was typed.
        .filter((entry) => entry.keywordScore >= minScore || entry.similarity >= SEMANTIC_ADMIT)
        .sort((a, b) => (b.total - a.total) || (Number(b.file.id) - Number(a.file.id)))
        .slice(0, limit)
        .map((entry) => {
            const { _vector, __fields, ...file } = entry.file;
            return {
                ...file,
                _score: entry.total,
                _matched: entry.matched,
                _fuzzy: entry.kinds.includes('fuzzy') && !entry.kinds.includes('exact'),
                // True when the file surfaced because of what it MEANS rather
                // than what it says - the page labels these so a result with no
                // visible connection to the query does not look like a bug.
                _semantic: entry.keywordScore < minScore && entry.similarity >= SEMANTIC_ADMIT,
                ...(entry.similarity ? { _similarity: Math.round(entry.similarity * 1000) / 1000 } : {})
            };
        });
}

export default {
    normalize, stem, synonymsFor, parseQuery, likePatterns, scoreFile, rankFiles,
    splitDescription, similarity, editDistance, inverseDocumentFrequency,
    proximityBonus, semanticPoints
};
