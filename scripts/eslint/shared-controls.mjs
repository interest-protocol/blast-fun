import { dirname, relative, resolve } from 'node:path';
import legacy from './shared-controls-legacy.json' with { type: 'json' };

const nativeControls = new Set(['button', 'input', 'textarea', 'select']);
const primitives = /components\/blast-ui\/(Button|Checkbox|TextField|Segmented)\.tsx$/;

function importedControls(body) {
  const controlNames = new Set(['Button','ButtonLink','IconButton','DisclosureButton','DisclosureSummary','Checkbox','TextField','TextArea','SelectField','FieldGroup']);
  const buttons = new Set(['Button', 'IconButton']);
  const chevrons = new Set(['ChevronIcon']);
  for (const node of body) {
    if (node.type === 'ImportDeclaration') recordAliases(node, controlNames, buttons, chevrons);
  }
  return { controlNames, buttons, chevrons };
}

function recordAliases(node, controlNames, buttons, chevrons) {
  const icons = /blast-ui\/Icons(\.tsx)?$/.test(node.source.value);
  const controls = /blast-ui\/(Button|Checkbox|TextField)(\.tsx)?$/.test(node.source.value);
  for (const { imported, local } of node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier')) {
    if (icons && /^(Chevron|Chev).*Icon$/.test(imported.name)) chevrons.add(local.name);
    if (/^(Chevron|Chev).*(Icon)?$/.test(imported.name)) chevrons.add(local.name);
    if (controls && controlNames.has(imported.name)) controlNames.add(local.name);
    if (controls && buttons.has(imported.name)) buttons.add(local.name);
  }
}

function isDisclosureChevron(node, buttons, chevrons) {
  if (!chevrons.has(node.name.name)) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'JSXElement') continue;
    const opening = parent.openingElement;
    const name = opening.name.type === 'JSXIdentifier' ? opening.name.name : '';
    const expanded = opening.attributes.some(attr => ['aria-expanded', 'aria-haspopup'].includes(attr.name?.name));
    if (name === 'summary' || name.endsWith('Trigger') || buttons.has(name) || (name === 'button' && expanded)) return true;
  }
  return false;
}

/** Existing screens may migrate gradually; new screens cannot start another control system. */
export const sharedControls = {
  meta: {
    type: 'problem', schema: [],
    messages: {
      native: 'Use the shared Button/IconButton, Checkbox, TextField/TextArea or SelectField. Existing native-control counts may only decrease; specialized adapters require a documented exception.',
      style: 'Shared controls own geometry and focus. Use a size/variant and a layout class instead of inline styles.',
      disclosure: 'Use DisclosureButton for an expandable chevron control; it owns glyph size, inset and expansion direction.',
      boundary: 'UI primitives must not import feature, data or transaction logic. Pass presentation props and callbacks.',
    },
  },
  create(context) {
    const file = relative(context.cwd, context.filename).replaceAll('\\', '/');
    const native = [];
    const inPrimitive = primitives.test(file);
    const { controlNames, buttons, chevrons } = importedControls(context.sourceCode.ast.body);
    return {
      JSXOpeningElement(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
        if (!inPrimitive && isDisclosureChevron(node, buttons, chevrons)) context.report({ node, messageId: 'disclosure' });
        // Select migration is complete; a legacy allowance cannot reintroduce browser arrows.
        if (name === 'select' && !inPrimitive) { context.report({ node, messageId: 'native' }); return; }
        if (nativeControls.has(name) && !inPrimitive) {
          // The grid library owns this drag adapter's hit geometry and ref contract.
          const resize = file.endsWith('/workspace/WorkspaceLayout.tsx') && node.attributes.some(attr => attr.name?.name === 'data-grid-resize');
          if (!resize) native.push(node);
        }
        if (controlNames.has(name)) {
          const style = node.attributes.find(attr => attr.name?.name === 'style');
          if (style) context.report({ node: style, messageId: 'style' });
        }
      },
      ImportDeclaration(node) {
        if (!inPrimitive) return;
        const source = node.source.value;
        const target = source.startsWith('#web/') ? `apps/web/src/${source.slice(5)}`
          : source.startsWith('.') ? relative(context.cwd, resolve(dirname(context.filename), source)).replaceAll('\\', '/') : source;
        if (/^apps\/web\/src\/(modules|lib|components\/(?:social|launchpad))(?:\/|$)/.test(target)) {
          context.report({ node, messageId: 'boundary' });
        }
      },
      'Program:exit'() {
        const allowance = legacy[file] ?? 0;
        for (const node of native.slice(allowance)) context.report({ node, messageId: 'native' });
      },
    };
  },
};
