import { describe, expect, it } from 'vitest';
import { brand, brandCssVars, faviconDataUri } from '../src/theme';

describe('NAYAYA & CO. brand tokens (single source of truth)', () => {
  it('defines the brand palette from the brand package', () => {
    expect(brand.name).toBe('NAYAYA & CO.');
    expect(brand.tagline).toBe('Everything Home. One Name.');
    expect(brand.colors.primary).toBe('#B55A3A'); // Deep Terracotta
    expect(brand.colors.secondary).toBe('#2B2622'); // Warm Charcoal
    expect(brand.colors.accent).toBe('#C9A66B'); // Antique Gold
    expect(brand.colors.base).toBe('#F5EFE6'); // Warm Ivory
  });

  it('exposes serif + sans font families', () => {
    expect(brand.fonts.serif).toContain('Playfair Display');
    expect(brand.fonts.sans).toContain('Inter');
  });

  it('exposes a spacing scale', () => {
    expect(brand.spacing.xs).toBe('4px');
    expect(brand.spacing.xxl).toBe('32px');
  });

  it('generates CSS custom properties covering the whole palette', () => {
    const vars = brandCssVars();
    expect(vars).toContain('--brand-primary: #B55A3A;');
    expect(vars).toContain('--brand-base: #F5EFE6;');
    expect(vars).toContain('--brand-accent: #C9A66B;');
    expect(vars).toContain('--brand-serif:');
    expect(vars).toContain('--brand-sans:');
    expect(vars).toContain('--brand-space-xxl:');
  });

  it('builds the logo lockup and favicon mark from the tokens', () => {
    expect(brand.logo.lockupSvg).toContain('NAYAYA');
    expect(brand.logo.lockupSvg).toContain('&amp; CO.');
    expect(brand.logo.lockupSvg).toContain(brand.colors.primary);
    expect(brand.logo.lockupSvg).toContain(brand.colors.accent);
    expect(brand.logo.faviconSvg).toContain(brand.colors.primary);
  });

  it('produces a data-URI favicon', () => {
    const uri = faviconDataUri();
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('<svg');
  });
});