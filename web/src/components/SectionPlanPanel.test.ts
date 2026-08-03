import { describe, expect, it } from 'vitest';
import { shouldDisableSectionAdoption, shouldDisableSectionPlanClose } from './SectionPlanPanel';

describe('shouldDisableSectionAdoption', () => {
  it('disables adoption while section planning is streaming', () => {
    expect(shouldDisableSectionAdoption({
      streaming: true,
      adopting: false,
      titleCount: 3,
    })).toBe(true);
  });

  it('disables adoption while adoption is already running', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: true,
      titleCount: 3,
    })).toBe(true);
  });

  it('disables adoption when no section titles were parsed', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: false,
      titleCount: 0,
    })).toBe(true);
  });

  it('allows adoption only when titles exist and no async work is running', () => {
    expect(shouldDisableSectionAdoption({
      streaming: false,
      adopting: false,
      titleCount: 3,
    })).toBe(false);
  });
});

describe('shouldDisableSectionPlanClose', () => {
  it('disables closing while adoption is already running', () => {
    expect(shouldDisableSectionPlanClose({ adopting: true })).toBe(true);
  });

  it('allows closing when adoption is idle', () => {
    expect(shouldDisableSectionPlanClose({ adopting: false })).toBe(false);
  });
});
