import { describe, it, expect, beforeEach } from 'vitest';
import {
    normalizeVector, cosine, packVector, unpackVector, documentTextFor,
    embedQuery, embedDocument, isEmbeddingEnabled, embeddingHealth, resetEmbeddingState
} from '../../services/embeddingService.js';

beforeEach(() => resetEmbeddingState());

describe('normalizeVector', () => {
    it('scales a vector to unit length', () => {
        const unit = normalizeVector([3, 4]);
        expect(unit[0]).toBeCloseTo(0.6, 6);
        expect(unit[1]).toBeCloseTo(0.8, 6);
        expect(Math.hypot(...unit)).toBeCloseTo(1, 6);
    });

    it('does not divide by zero on an all-zero vector', () => {
        expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
    });
});

describe('cosine', () => {
    it('is 1 for identical directions and 0 for perpendicular ones', () => {
        expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
        expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
        expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
    });

    it('refuses to compare vectors of different lengths rather than guessing', () => {
        // Two models produce vectors of different sizes. Silently comparing a
        // prefix would return a confident number that means nothing.
        expect(cosine([1, 0, 0], [1, 0])).toBe(0);
        expect(cosine(null, [1, 0])).toBe(0);
    });
});

describe('packVector / unpackVector', () => {
    it('round-trips a vector', () => {
        const vector = normalizeVector([0.1234567, -0.9, 0.4]);
        const restored = unpackVector(packVector(vector));
        expect(restored).toHaveLength(3);
        restored.forEach((value, i) => expect(value).toBeCloseTo(vector[i], 5));
    });

    it('returns null for anything that is not a usable vector', () => {
        expect(unpackVector(null)).toBeNull();
        expect(unpackVector('')).toBeNull();
        expect(unpackVector('not json')).toBeNull();
        expect(unpackVector('[]')).toBeNull();
        expect(unpackVector('{"a":1}')).toBeNull();
        expect(unpackVector('[1,"x"]')).toBeNull();
        expect(unpackVector('[1,null]')).toBeNull();
    });
});

describe('documentTextFor', () => {
    it('leads with the title and includes the category and description', () => {
        const text = documentTextFor({ title: 'Entropy', category: 'Physics', description: 'notes' });
        expect(text.startsWith('Entropy')).toBe(true);
        expect(text).toContain('Category: Physics');
        expect(text).toContain('notes');
    });

    it('survives a row with missing fields', () => {
        expect(documentTextFor({})).toBe('');
        expect(documentTextFor(null)).toBe('');
    });
});

describe('with no API key configured', () => {
    // The suite runs without GEMINI_API_KEY, which is exactly the state a
    // fresh checkout is in - so this is the path most people will hit.
    it('reports itself as disabled', () => {
        expect(isEmbeddingEnabled()).toBe(false);
        expect(embeddingHealth().enabled).toBe(false);
    });

    it('returns null instead of throwing, so search still answers', async () => {
        await expect(embedQuery('anything')).resolves.toBeNull();
        await expect(embedDocument('anything')).resolves.toBeNull();
    });

    it('returns null for an empty input without calling anything', async () => {
        await expect(embedQuery('')).resolves.toBeNull();
        await expect(embedQuery('   ')).resolves.toBeNull();
        await expect(embedDocument('')).resolves.toBeNull();
    });
});
