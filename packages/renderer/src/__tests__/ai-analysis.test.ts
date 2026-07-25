import { describe, it, expect } from 'vitest';
import { renderAiAnalysisBlock } from '../ai-analysis.js';

describe('renderAiAnalysisBlock', () => {
  it('picks contracted AI fields when present', () => {
    const html = renderAiAnalysisBlock({
      summary: 'Deal at risk',
      category: 'high',
      score: 87,
      confidence: 0.92,
      reasoning: 'No activity in 14 days',
      key_points: ['no response', 'missed call'],
    });
    expect(html).toContain('Deal at risk');
    expect(html).toContain('Category');
    expect(html).toContain('high');
    expect(html).toContain('Score');
    expect(html).toContain('Confidence');
    expect(html).toContain('92%');
    expect(html).toContain('no response');
  });

  it('renders plain strings as a single paragraph', () => {
    expect(renderAiAnalysisBlock('hello')).toContain('<p class="ai-text">hello');
  });

  it('escapes user-supplied strings (XSS)', () => {
    const html = renderAiAnalysisBlock({
      summary: '<img onerror=alert(1)>',
      reasoning: '<script>x</script>',
    });
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img onerror');
  });

  it('falls back to JSON when no contracted field matches', () => {
    const html = renderAiAnalysisBlock({ custom_field: 'value' });
    expect(html).toContain('ai-json');
    expect(html).toContain('custom_field');
  });

  it('renders null / undefined as an empty placeholder', () => {
    expect(renderAiAnalysisBlock(null)).toContain('No ai_analysis data');
    expect(renderAiAnalysisBlock(undefined)).toContain('No ai_analysis data');
  });
});
