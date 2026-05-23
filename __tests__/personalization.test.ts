/**
 * Tests for the personalization renderer - the single source of truth for
 * how {{...}} merge tags, {{#if}} conditionals, and {{ | fallback }} filters
 * render at send time. Covers Smartlead-exact paste-in syntax, the safety
 * contract (never throws on malformed input), backward compatibility with
 * plain {{token}} templates, and the save-time validators.
 */

import {
    renderPersonalization,
    validatePersonalization,
    validateStepTemplates,
    evaluateCondition,
} from '../src/utils/personalization';

const lead = {
    first_name: 'Jane',
    last_name: 'Doe',
    company: 'Acme',
    title: 'founder',
    google_review: '5',
    number_of_reviews: '8',
    empty_field: '',
    blank_field: '   ',
};

describe('renderPersonalization - simple tokens', () => {
    it('substitutes a known token', () => {
        expect(renderPersonalization('Hi {{first_name}}', lead)).toBe('Hi Jane');
    });

    it('renders a missing token as empty string (backward compatible)', () => {
        expect(renderPersonalization('Hi {{first_name}} at {{website}}', lead)).toBe('Hi Jane at ');
    });

    it('is case-insensitive on token names', () => {
        expect(renderPersonalization('{{First_Name}} {{COMPANY}}', lead)).toBe('Jane Acme');
    });

    it('returns the template unchanged when there are no tags', () => {
        expect(renderPersonalization('plain text, no tags', lead)).toBe('plain text, no tags');
    });

    it('handles empty / whitespace tag spacing', () => {
        expect(renderPersonalization('{{ first_name }}', lead)).toBe('Jane');
    });

    it('leaves single-brace spintax untouched for the later spintax stage', () => {
        expect(renderPersonalization('{Hi|Hey} {{first_name}}', lead)).toBe('{Hi|Hey} Jane');
    });
});

describe('renderPersonalization - fallback filter', () => {
    it('uses the value when present', () => {
        expect(renderPersonalization('{{first_name | fallback: "there"}}', lead)).toBe('Jane');
    });

    it('uses the default when the field is missing', () => {
        expect(renderPersonalization('{{website | fallback: "our site"}}', lead)).toBe('our site');
    });

    it('uses the default when the field is empty', () => {
        expect(renderPersonalization('{{empty_field | fallback: "X"}}', lead)).toBe('X');
    });

    it('treats a whitespace-only value as empty and uses the default', () => {
        expect(renderPersonalization('{{blank_field | fallback: "X"}}', lead)).toBe('X');
    });

    it('accepts single quotes, no quotes, and tight spacing', () => {
        expect(renderPersonalization("{{website | fallback: 'home'}}", lead)).toBe('home');
        expect(renderPersonalization('{{website|fallback:home}}', lead)).toBe('home');
    });
});

describe('renderPersonalization - conditional truthiness', () => {
    it('renders the consequent when the field is present', () => {
        expect(renderPersonalization('{{#if first_name}}Hey {{first_name}},{{else}}Hey there,{{/if}}', lead))
            .toBe('Hey Jane,');
    });

    it('renders the else branch when the field is missing', () => {
        expect(renderPersonalization('{{#if website}}see {{website}}{{else}}Hey there,{{/if}}', lead))
            .toBe('Hey there,');
    });

    it('renders nothing when missing and there is no else', () => {
        expect(renderPersonalization('A{{#if website}} {{website}}{{/if}}B', lead)).toBe('AB');
    });

    it('treats whitespace-only as falsy', () => {
        expect(renderPersonalization('{{#if blank_field}}yes{{else}}no{{/if}}', lead)).toBe('no');
    });
});

describe('renderPersonalization - comparison operators (Smartlead-exact)', () => {
    it('== matches case-insensitively with quoted operator and value', () => {
        expect(renderPersonalization(`{{#if title '==' "Founder"}}As the founder{{else}}x{{/if}}`, lead))
            .toBe('As the founder');
    });

    it('!= works', () => {
        expect(renderPersonalization(`{{#if title '!=' "ceo"}}not ceo{{/if}}`, lead)).toBe('not ceo');
    });

    it('gte / lte word operators compare numerically', () => {
        expect(renderPersonalization(`{{#if google_review 'gte' 4}}great{{else}}meh{{/if}}`, lead)).toBe('great');
        expect(renderPersonalization(`{{#if google_review 'lte' 4}}low{{else}}high{{/if}}`, lead)).toBe('high');
    });

    it('< and > symbols compare numerically', () => {
        expect(renderPersonalization(`{{#if number_of_reviews '<' 15}}under 15{{/if}}`, lead)).toBe('under 15');
        expect(renderPersonalization(`{{#if number_of_reviews '>' 15}}over 15{{/if}}`, lead)).toBe('');
    });

    it('accepts bare (unquoted) operators too', () => {
        expect(renderPersonalization(`{{#if title == "founder"}}yes{{/if}}`, lead)).toBe('yes');
    });

    it('falls back to string compare when values are not numeric', () => {
        expect(renderPersonalization(`{{#if company '>' "Abc"}}after{{else}}before{{/if}}`, lead)).toBe('after');
    });
});

describe('renderPersonalization - HTML-encoded operators (rich-text bodies)', () => {
    it('decodes &lt; / &gt; so comparison operators work in HTML bodies', () => {
        expect(renderPersonalization(`{{#if number_of_reviews '&lt;' 15}}under{{else}}over{{/if}}`, lead)).toBe('under');
        expect(renderPersonalization(`{{#if number_of_reviews '&gt;' 5}}over{{/if}}`, lead)).toBe('over');
    });

    it('decodes &lt;= / &gt;= encoded operators', () => {
        expect(renderPersonalization(`{{#if google_review '&gt;=' 5}}top{{/if}}`, lead)).toBe('top');
    });

    it('decodes encoded quotes around the value', () => {
        expect(renderPersonalization(`{{#if title '==' &quot;founder&quot;}}yes{{/if}}`, lead)).toBe('yes');
    });

    it('decodes entities in a fallback default', () => {
        expect(renderPersonalization('{{website | fallback: &quot;A &amp; B&quot;}}', lead)).toBe('A & B');
    });
});

describe('renderPersonalization - nesting', () => {
    it('resolves nested conditionals', () => {
        const tpl = `{{#if first_name}}Hi {{first_name}}{{#if title '==' "founder"}} (founder){{/if}}!{{else}}Hi!{{/if}}`;
        expect(renderPersonalization(tpl, lead)).toBe('Hi Jane (founder)!');
        expect(renderPersonalization(tpl, { ...lead, title: 'manager' })).toBe('Hi Jane!');
    });

    it('renders the Smartlead help-article fallback example verbatim', () => {
        const tpl = '{{#if first_name}}Hey {{first_name}}, {{else}}Hey there, {{/if}}welcome';
        expect(renderPersonalization(tpl, lead)).toBe('Hey Jane, welcome');
        expect(renderPersonalization(tpl, { ...lead, first_name: '' })).toBe('Hey there, welcome');
    });
});

describe('renderPersonalization - safety contract (never throws)', () => {
    const cases = [
        '{{#if first_name}}no close',
        'stray {{/if}} here',
        '{{else}} alone',
        '{{#if a}}x{{else}}y{{else}}z{{/if}}',
        '{{#if title ~~ "x"}}bad op{{/if}}',
        '{{#if}}empty cond{{/if}}',
    ];
    for (const tpl of cases) {
        it(`does not throw and returns a string for: ${tpl}`, () => {
            const out = renderPersonalization(tpl, lead);
            expect(typeof out).toBe('string');
            // degraded render must not leave literal control tags behind
            expect(out).not.toContain('{{#if');
            expect(out).not.toContain('{{/if}}');
            expect(out).not.toContain('{{else}}');
        });
    }

    it('handles empty and undefined-ish templates', () => {
        expect(renderPersonalization('', lead)).toBe('');
        expect(renderPersonalization(undefined as unknown as string, lead)).toBe('');
    });
});

describe('evaluateCondition', () => {
    const t = { score: '10', name: 'jane', blank: '' };
    it('truthiness', () => {
        expect(evaluateCondition('name', null, '', t)).toBe(true);
        expect(evaluateCondition('blank', null, '', t)).toBe(false);
        expect(evaluateCondition('missing', null, '', t)).toBe(false);
    });
    it('numeric comparisons', () => {
        expect(evaluateCondition('score', '>=', '10', t)).toBe(true);
        expect(evaluateCondition('score', '>', '10', t)).toBe(false);
        expect(evaluateCondition('score', '<', '11', t)).toBe(true);
    });
    it('equality is case-insensitive', () => {
        expect(evaluateCondition('name', '==', 'JANE', t)).toBe(true);
        expect(evaluateCondition('name', '!=', 'JANE', t)).toBe(false);
    });
});

describe('validatePersonalization', () => {
    it('returns no issues for valid templates', () => {
        expect(validatePersonalization('{{#if a}}x{{else}}y{{/if}} {{b | fallback: "z"}}')).toEqual([]);
        expect(validatePersonalization('plain {{first_name}}')).toEqual([]);
    });

    it('flags an unclosed if', () => {
        const issues = validatePersonalization('{{#if a}}x');
        expect(issues.map(i => i.code)).toContain('unclosed_if');
    });

    it('flags a stray close', () => {
        expect(validatePersonalization('x{{/if}}').map(i => i.code)).toContain('unexpected_close');
    });

    it('flags a stray else and a duplicate else', () => {
        expect(validatePersonalization('{{else}}').map(i => i.code)).toContain('unexpected_else');
        expect(validatePersonalization('{{#if a}}1{{else}}2{{else}}3{{/if}}').map(i => i.code)).toContain('unexpected_else');
    });

    it('flags an unparseable condition', () => {
        expect(validatePersonalization('{{#if a ~~ "x"}}y{{/if}}').map(i => i.code)).toContain('bad_condition');
    });
});

describe('validateStepTemplates', () => {
    it('returns no errors for valid steps', () => {
        const errors = validateStepTemplates([
            { step_number: 1, subject: 'Hi {{first_name}}', body_html: '{{#if company}}{{company}}{{/if}}' },
        ]);
        expect(errors).toEqual([]);
    });

    it('labels errors by step and field, including variants', () => {
        const errors = validateStepTemplates([
            { step_number: 1, subject: '{{#if a}}x', body_html: 'ok' },
            {
                step_number: 2,
                body_html: 'fine',
                variants: [{ body_html: 'stray {{/if}}' }],
            },
        ]);
        expect(errors.some(e => e.startsWith('Step 1 (subject):'))).toBe(true);
        expect(errors.some(e => e.includes('Step 2 (variant 1 body)'))).toBe(true);
    });

    it('tolerates null / non-array input', () => {
        expect(validateStepTemplates(null)).toEqual([]);
        expect(validateStepTemplates(undefined)).toEqual([]);
    });
});
