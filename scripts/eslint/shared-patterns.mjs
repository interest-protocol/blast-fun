import { relative } from 'node:path';
import legacy from './shared-patterns-legacy.json' with { type: 'json' };

const primitive = /^apps\/web\/src\/components\/blast-ui\//;
// The 16px disclosure chevron ("m6 9 6 6 6-6") belongs to ControlChevron, DisclosureButton and SelectField.
const chevronPath = /^\s*m\s*6\s+9\s*6\s+6\s*6\s*-6\s*$/i;

function classTokens(attr) {
  const value = attr.value;
  if (!value) return [];
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value.split(/\s+/);
  if (value.type !== 'JSXExpressionContainer') return [];
  const strings = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    if (node.type === 'TemplateElement') strings.push(node.value.cooked ?? '');
    for (const key of Object.keys(node)) if (key !== 'parent') {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(value.expression);
  return strings.flatMap((text) => text.split(/\s+/));
}

/** Page-level parts have one owner; new screens cannot start another tab, empty-state or chevron system. */
export const sharedPatterns = {
  meta: {
    type: 'problem', schema: [],
    messages: {
      seg: 'Use Segmented or SegmentedLinks from blast-ui instead of hand-built `.seg` markup.',
      empty: 'Use EmptyState from blast-ui instead of the `.empty` class.',
      chevron: 'Use DisclosureButton or SelectField: the shared trigger owns the dropdown chevron.',
      thumb: 'SegThumb is internal to blast-ui; render Segmented or SegmentedLinks.',
      tablist: 'Use Segmented (tabs) or SegmentedLinks (tabs): a hand-built tablist repeats the track, thumb and keyboard model.',
    },
  },
  create(context) {
    const file = relative(context.cwd, context.filename).replaceAll('\\', '/');
    if (primitive.test(file)) return {};
    const found = [];
    return {
      JSXAttribute(node) {
        const name = node.name?.name;
        if (name === 'className') {
          const tokens = classTokens(node);
          if (tokens.includes('seg') || tokens.includes('seg-ind')) found.push({ node, messageId: 'seg' });
          if (tokens.includes('empty')) found.push({ node, messageId: 'empty' });
        }
        if (name === 'd' && node.value?.type === 'Literal' && chevronPath.test(String(node.value.value))) found.push({ node, messageId: 'chevron' });
        if (name === 'role' && node.value?.type === 'Literal' && node.value.value === 'tablist') found.push({ node, messageId: 'tablist' });
      },
      ImportDeclaration(node) {
        if (/blast-ui\/SegThumb(\.tsx)?$/.test(node.source.value)) found.push({ node, messageId: 'thumb' });
      },
      'Program:exit'() {
        const allowance = legacy[file] ?? {};
        const seen = {};
        for (const item of found) {
          seen[item.messageId] = (seen[item.messageId] ?? 0) + 1;
          if (seen[item.messageId] > (allowance[item.messageId] ?? 0)) context.report(item);
        }
      },
    };
  },
};
