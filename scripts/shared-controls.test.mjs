import assert from 'node:assert/strict';
import test from 'node:test';
import { Linter } from 'eslint';
import { sharedControls } from './eslint/shared-controls.mjs';

function lint(code, filename = 'apps/web/src/components/NewFeature.tsx') {
  return new Linter().verify(code, [{
    files: ['**/*.tsx'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'blast-ui': { rules: { 'shared-controls': sharedControls } } },
    rules: { 'blast-ui/shared-controls': 'error' },
  }], { filename });
}
test('new features across the app must reuse controls; layout composition remains free', () => {
  assert.equal(lint('const x = <div><Button size="sm">Save</Button><Checkbox /><TextField /></div>').length, 0);
  assert.equal(lint('const x = <div><button>Save</button><input /><textarea /><select /></div>').length, 4);
  assert.equal(lint('const x = <Button style={{borderRadius:0}}>Save</Button>').at(0).messageId, 'style');
  assert.equal(lint('import {Button as Action} from \"#web/components/blast-ui/Button.tsx\"; const x = <Action style={{borderRadius:0}}>Save</Action>').at(0).messageId, 'style');
});
test('native elements belong in the shared primitive; feature imports do not', () => {
  const filename = 'apps/web/src/components/blast-ui/Button.tsx';
  assert.equal(lint('const x = <button />', filename).length, 0);
  assert.equal(lint('import x from "#web/modules/social/transaction";', filename).at(0).messageId, 'boundary');
  assert.equal(lint('import x from "../social/queries";', filename).at(0).messageId, 'boundary');
  assert.equal(lint('import x from "../../modules/trade";', filename).at(0).messageId, 'boundary');
});
test('only the documented grid adapter is exempt in the migrated workspace', () => {
  const file = 'apps/web/src/components/social/blast-mode/workspace/WorkspaceLayout.tsx';
  assert.equal(lint('const x = <button data-grid-resize="se" />', file).length, 0);
  assert.equal(lint('const x = <button />', file).at(0).messageId, 'native');
  assert.equal(lint('const x = <button data-grid-resize="se" />').at(0).messageId, 'native');
});

test('workspace disclosures use the shared chevron including aliased imports', () => {
  const file = 'apps/web/src/components/social/blast-mode/workspace/Example.tsx';
  const handBuilt = 'import {Button as Action} from "#web/components/blast-ui/Button.tsx"; import {ChevronIcon as Arrow} from "#web/components/blast-ui/Icons.tsx"; const x = <Action aria-expanded={true}>Details<Arrow /></Action>';
  assert.equal(lint(handBuilt, file).at(0)?.messageId, 'disclosure');
  assert.equal(lint('const x = <IconButton aria-label="Details"><ChevronIcon /></IconButton>', file).at(0)?.messageId, 'disclosure');
  assert.equal(lint('const x = <DisclosureButton aria-label="Details" iconOnly aria-expanded={true} />', file).length, 0);
  assert.equal(lint('const x = <IconButton aria-label="Next"><ArrowRightIcon /></IconButton>', file).length, 0);
});

test('select and disclosure geometry cannot be bypassed elsewhere in the website', () => {
  const file = 'apps/web/src/components/blast-ui/MoreNavigation.tsx';
  assert.equal(lint('const x = <select />', file).at(0)?.messageId, 'native');
  assert.equal(lint('import {ChevIcon as Arrow} from "../profile/icons"; const x = <button aria-expanded={false}><span>More<Arrow /></span></button>', file).some(message => message.messageId === 'disclosure'), true);
  assert.equal(lint('const x = <DisclosureButton leadingIcon={<DotsIcon />}>More</DisclosureButton>', file).length, 0);
  assert.equal(lint('import {ChevronIcon} from "./Icons"; const x = <a href="/portfolio"><ChevronIcon /></a>', file).length, 0);
});
