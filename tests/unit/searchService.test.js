import { describe, it, expect } from 'vitest';
import {
    normalize, stem, synonymsFor, parseQuery, likePatterns,
    splitDescription, similarity, scoreFile, rankFiles,
    inverseDocumentFrequency, proximityBonus, semanticPoints
} from '../../services/searchService.js';

/** Cosine for unit vectors, injected the way models/File.js injects the real one. */
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

const LIBRARY = [
    {
        id: 1,
        title: 'Thermodynamics Lecture Notes',
        description: 'Entropy, enthalpy and the second law. | Keywords: thermodynamics entropy enthalpy carnot',
        category: 'Physics',
        username: 'ali'
    },
    {
        id: 2,
        title: 'ملخص الفيزياء - الفصل الأول',
        description: 'شرح مبسط للحركة والقوى',
        category: 'فيزياء',
        username: 'sara'
    },
    {
        id: 3,
        title: 'Calculus Problem Set',
        description: 'Integration by parts | Keywords: calculus integral derivative',
        category: 'Mathematics',
        username: 'omar'
    },
    {
        id: 4,
        title: 'Pasta Recipes',
        description: 'Family cookbook',
        category: 'Food',
        username: 'nora'
    }
];

const ids = (query, options) => rankFiles(LIBRARY, query, options).map((file) => file.id);

describe('normalize', () => {
    it('folds case, punctuation and spacing', () => {
        expect(normalize('  Thermo-Dynamics!!  NOTES ')).toBe('thermo dynamics notes');
    });

    it('folds Arabic diacritics, tatweel and spelling variants', () => {
        // All four spellings of the same word must collapse to one form,
        // otherwise a search only finds the files that happened to be typed
        // the same way as the query.
        const forms = ['الفِيزياء', 'الفيزيــاء', 'الفيزياء', 'الفيزياۤء'];
        const folded = new Set(forms.map((form) => normalize(form)));
        expect(folded.size).toBe(1);
        expect(normalize('مذكّرة')).toBe('مذكره');
        expect(normalize('مصطفى')).toBe('مصطفي');
    });

    it('survives null and undefined', () => {
        expect(normalize(null)).toBe('');
        expect(normalize(undefined)).toBe('');
    });
});

describe('stem', () => {
    it('trims English plurals and endings without inventing words', () => {
        expect(stem('notes')).toBe('note');
        expect(stem('summaries')).toBe('summary');
        expect(stem('running')).toBe('runn');
        expect(stem('class')).toBe('class');
    });

    it('trims the Arabic definite article and plural tails', () => {
        expect(stem(normalize('الملخصات'))).toBe('ملخص');
        expect(stem(normalize('المعلمين'))).toBe('معلم');
    });
});

describe('synonymsFor', () => {
    it('links English and Arabic names for the same subject', () => {
        expect(synonymsFor('physics')).toContain('فيزياء');
        expect(synonymsFor(normalize('فيزياء'))).toContain('physics');
    });

    it('reaches a group through the definite article and a plural', () => {
        expect(synonymsFor(normalize('الرياضيات'))).toContain('math');
    });

    it('returns nothing for a word it does not know', () => {
        expect(synonymsFor('zebra')).toEqual([]);
    });
});

describe('parseQuery / likePatterns', () => {
    it('drops stop words but never returns an empty term list', () => {
        expect(parseQuery('notes about the physics').terms.map((term) => term.word))
            .toEqual(['notes', 'physics']);
        expect(parseQuery('the').terms.map((term) => term.word)).toEqual(['the']);
    });

    it('builds LIKE patterns covering stems and synonyms', () => {
        const patterns = likePatterns(parseQuery('physics'));
        expect(patterns).toContain('%physics%');
        expect(patterns).toContain('%فيزياء%');
    });

    it('caps the pattern count so one query cannot build a giant statement', () => {
        const patterns = likePatterns(parseQuery('math physics chemistry biology notes exam lecture book solution lab'));
        expect(patterns.length).toBeLessThanOrEqual(48);
    });
});

describe('splitDescription', () => {
    it('separates the AI keyword tail from the human description', () => {
        const { body, keywords } = splitDescription('Entropy notes | Keywords: entropy carnot');
        expect(body).toBe('Entropy notes');
        expect(keywords).toBe('entropy carnot');
    });

    it('leaves a plain description alone', () => {
        expect(splitDescription('Just a description').keywords).toBe('');
    });
});

describe('similarity', () => {
    it('scores a single transposition as nearly identical', () => {
        expect(similarity('thermodynamics', 'thermodyanmics')).toBeGreaterThan(0.85);
    });

    it('scores unrelated words low', () => {
        expect(similarity('physics', 'cooking')).toBeLessThan(0.4);
    });
});

describe('rankFiles', () => {
    it('finds an exact title match and leaves unrelated files out', () => {
        expect(ids('thermodynamics')).toEqual([1]);
    });

    it('tolerates a typo the old LIKE query could never match', () => {
        // 'thermodyanmics' shares no substring with the title, so
        // "WHERE title LIKE '%thermodyanmics%'" returned nothing at all.
        expect(ids('thermodyanmics')).toEqual([1]);
    });

    it('matches an English query against Arabic material', () => {
        expect(ids('physics')).toContain(2);
    });

    it('matches an Arabic query against English material', () => {
        expect(ids('رياضيات')).toContain(3);
    });

    it('ignores word order and filler words', () => {
        expect(ids('notes for thermodynamics')).toEqual(ids('thermodynamics notes'));
    });

    it('ranks a file matching every term above one matching a single term', () => {
        const ranked = rankFiles(LIBRARY, 'ملخص فيزياء');
        expect(ranked[0].id).toBe(2);
    });

    it('weights the title above the description', () => {
        const files = [
            { id: 10, title: 'Statistics', description: 'nothing here', category: 'Other', username: 'a' },
            { id: 11, title: 'Other', description: 'statistics somewhere in the body', category: 'Other', username: 'b' }
        ];
        expect(rankFiles(files, 'statistics').map((file) => file.id)).toEqual([10, 11]);
    });

    it('searches the AI keywords stored on upload', () => {
        expect(ids('carnot')).toEqual([1]);
    });

    it('searches the category and the uploader', () => {
        expect(ids('nora')).toEqual([4]);
        expect(ids('food')).toEqual([4]);
    });

    it('returns nothing for a query that matches nothing', () => {
        expect(ids('quantum chromodynamics zebra')).toEqual([]);
    });

    it('returns nothing for an empty query instead of everything', () => {
        expect(rankFiles(LIBRARY, '')).toEqual([]);
        expect(rankFiles(LIBRARY, '   ')).toEqual([]);
    });

    it('flags rows that only matched fuzzily, so the UI can say so', () => {
        const [best] = rankFiles(LIBRARY, 'thermodyanmics');
        expect(best._fuzzy).toBe(true);
        expect(rankFiles(LIBRARY, 'thermodynamics')[0]._fuzzy).toBe(false);
    });

    it('honours the result limit', () => {
        expect(rankFiles(LIBRARY, 'notes physics calculus pasta', { limit: 2 }).length).toBe(2);
    });

    it('does not fall over on rows with missing fields', () => {
        const messy = [{ id: 9, title: null, description: undefined, category: null, username: null }];
        expect(() => rankFiles(messy, 'anything')).not.toThrow();
        expect(rankFiles(messy, 'anything')).toEqual([]);
    });
});

describe('scoreFile', () => {
    it('prefers a whole-word match over an accidental substring', () => {
        const whole = scoreFile({ id: 1, title: 'Art history', description: '', category: '', username: '' }, parseQuery('art'));
        const inside = scoreFile({ id: 2, title: 'Particles', description: '', category: '', username: '' }, parseQuery('art'));
        expect(whole.score).toBeGreaterThan(inside.score);
    });
});


describe('inverse document frequency', () => {
    const shelf = [
        { id: 1, title: 'Thermodynamics Notes', description: '', category: 'Physics', username: 'a' },
        { id: 2, title: 'Biology Notes', description: '', category: 'Biology', username: 'b' },
        { id: 3, title: 'Chemistry Notes', description: '', category: 'Chemistry', username: 'c' },
        { id: 4, title: 'History Notes', description: '', category: 'History', username: 'd' }
    ];

    it('weights a rare word above one that is in everything', () => {
        const parsed = parseQuery('thermodynamics notes');
        const weights = inverseDocumentFrequency(shelf, parsed, shelf.length);
        expect(weights.get('thermodynamics')).toBeGreaterThan(weights.get('notes'));
    });

    it('lets the rare word decide the ranking', () => {
        // Every file matches "notes"; only one matches "thermodynamics". Before
        // IDF the shared word contributed as much as the distinguishing one,
        // and an unrelated file could tie with the right one.
        const ranked = rankFiles(shelf, 'thermodynamics notes', { corpusSize: shelf.length });
        expect(ranked[0].id).toBe(1);
        expect(ranked[0]._score).toBeGreaterThan(ranked[1]._score * 1.4);
    });
});

describe('proximity', () => {
    const pair = [
        { id: 1, title: 'Linear Algebra', description: 'matrices', category: 'Math', username: 'a' },
        { id: 2, title: 'Linear equations and the history of modern algebra', description: '', category: 'Math', username: 'b' }
    ];

    it('prefers terms that sit next to each other', () => {
        const ranked = rankFiles(pair, 'linear algebra', { corpusSize: 2 });
        expect(ranked[0].id).toBe(1);
    });

    it('is zero for a single-term query', () => {
        expect(proximityBonus({ title: 'linear algebra', keywords: '' }, parseQuery('algebra'))).toBe(0);
    });

    it('is zero when the terms are far apart', () => {
        const fields = { title: 'linear one two three four five six algebra', keywords: '' };
        expect(proximityBonus(fields, parseQuery('linear algebra'))).toBe(0);
    });
});

describe('semanticPoints', () => {
    it('ignores similarity that is merely "both are study notes"', () => {
        expect(semanticPoints(0.4)).toBe(0);
        expect(semanticPoints(0.55)).toBe(0);
    });

    it('rises with similarity and never outweighs a perfect keyword match', () => {
        expect(semanticPoints(0.7)).toBeGreaterThan(0);
        expect(semanticPoints(0.9)).toBeGreaterThan(semanticPoints(0.7));
        expect(semanticPoints(1)).toBeLessThan(100);
    });
});

describe('rankFiles with embeddings', () => {
    // Two dimensions is enough to model "about the same thing" vs "not".
    const PLANTS = [1, 0];
    const ROCKS = [0, 1];

    const library = [
        { id: 1, title: 'Photosynthesis', description: 'chlorophyll', category: 'Biology', username: 'a', _vector: PLANTS },
        { id: 2, title: 'Igneous Rocks', description: 'basalt', category: 'Geology', username: 'b', _vector: ROCKS },
        { id: 3, title: 'How plants make food', description: '', category: 'Biology', username: 'c' }
    ];

    const rank = (query, vector) =>
        rankFiles(library, query, { corpusSize: 3, queryVector: vector, cosine: dot });

    it('finds a file that shares no word with the query', () => {
        // "chlorophyll" appears nowhere in the query and "photosynthesis"
        // appears nowhere in the file the student typed about. Keyword search
        // returns nothing here; the embedding is the only thing that connects
        // the two.
        const words = rankFiles(library, 'sunlight energy conversion', { corpusSize: 3 });
        expect(words.map((f) => f.id)).not.toContain(1);

        const meaning = rank('sunlight energy conversion', PLANTS);
        expect(meaning.map((f) => f.id)).toContain(1);
    });

    it('labels a meaning-only match so the page can explain it', () => {
        const [top] = rank('sunlight energy conversion', PLANTS);
        expect(top._semantic).toBe(true);
        expect(top._similarity).toBeGreaterThan(0.6);
    });

    it('does not label a file that also matched on words', () => {
        const found = rank('photosynthesis', PLANTS).find((f) => f.id === 1);
        expect(found._semantic).toBe(false);
    });

    it('still puts an exact keyword match first', () => {
        // File 3 is titled exactly what was typed but has no vector; file 1 is
        // a perfect semantic match. The student who typed the title wants the
        // title.
        const ranked = rank('how plants make food', PLANTS);
        expect(ranked[0].id).toBe(3);
    });

    it('leaves unrelated files out however the vectors point', () => {
        expect(rank('sunlight energy conversion', PLANTS).map((f) => f.id)).not.toContain(2);
    });

    it('never leaks the vector into the response', () => {
        for (const row of rank('photosynthesis', PLANTS)) {
            expect(row._vector).toBeUndefined();
            expect(row.__fields).toBeUndefined();
        }
    });

    it('behaves exactly as before when no query vector is available', () => {
        const without = rankFiles(library, 'photosynthesis', { corpusSize: 3 });
        expect(without.map((f) => f.id)).toEqual([1]);
    });
});
