import { describe, expect, it } from 'vitest';
import { generateSlug } from './slug';

const DNS_1035_LABEL = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

describe('generateSlug', () => {
  it('sin hint: usa el default legible + sufijo aleatorio', () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^preview-[a-f0-9]{6}$/);
  });

  it('con hint: lo convierte a kebab-case y agrega sufijo aleatorio', () => {
    const slug = generateSlug('Mi Proyecto Genial');
    expect(slug).toMatch(/^mi-proyecto-genial-[a-f0-9]{6}$/);
  });

  it('dos llamadas con el mismo hint producen slugs distintos (entropía real, no derivado solo del nombre)', () => {
    const a = generateSlug('mismo-nombre');
    const b = generateSlug('mismo-nombre');
    expect(a).not.toBe(b);
  });

  it('sanitiza caracteres fuera de a-z0-9 a guiones', () => {
    const slug = generateSlug('App_2.0 (beta)!!');
    expect(slug.replace(/-[a-f0-9]{6}$/, '')).toBe('app-2-0-beta');
  });

  it('hint vacío o solo símbolos cae al default legible', () => {
    expect(generateSlug('')).toMatch(/^preview-[a-f0-9]{6}$/);
    expect(generateSlug('!!!')).toMatch(/^preview-[a-f0-9]{6}$/);
  });

  it('trunca un hint muy largo para que el label completo respete DNS-1035 (<=63 chars)', () => {
    const slug = generateSlug('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug).toMatch(DNS_1035_LABEL);
  });

  it('el resultado siempre es un label DNS-1035 válido', () => {
    for (const hint of [undefined, 'Hola Mundo', '---raro---', '123numerico']) {
      expect(generateSlug(hint)).toMatch(DNS_1035_LABEL);
    }
  });
});
