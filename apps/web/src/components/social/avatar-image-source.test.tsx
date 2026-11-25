import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ShellAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { ShellAvatarRenderer, type RenderAvatar } from "#web/components/blast-ui/shell-avatar-renderer.ts";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";

import { AccountAvatar } from "./AccountAvatar";
import { avatarImageSources } from "#web/components/blast-ui/avatar-source.ts";
import { Avatar as PostAvatar } from "./post/PostMedia";
import { Avatar as ProfileAvatar } from "./profile/parts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { cardIdentityKey } from "@blast/core/modules/social/contracts/card-identity.ts";
import { CARD_EDITIONS, cardEditionForCrew } from "@blast/core/modules/mission-control/card-renderer/editions.ts";

/** X sign-in stores the 48 px `_normal` thumbnail; every avatar first loads the original, with no size suffix. */

const renderAccountAvatar: RenderAvatar = (props) => <AccountAvatar {...props} />;

const PHOTO = "https://pbs.twimg.com/profile_images/1800000000000000000/AbCd_ef_normal.jpg";
const ORIGINAL = PHOTO.replace("_normal", "");
/** A size suffix X may 404 on. No avatar surface may ever request one. */
const SIZE_SUFFIX = /_(?:mini|normal|bigger|\d+x\d+)\.(?:jpg|png)/;

test("an X photo tries its original then 400 px, and any other picture loads as stored", () => {
  const sized = ORIGINAL.replace("_ef", "_ef_400x400");
  assert.deepEqual(avatarImageSources(PHOTO), [ORIGINAL, sized]);
  assert.deepEqual(avatarImageSources(PHOTO.replace("_normal", "_400x400")), [ORIGINAL, sized]);
  for (const url of ["https://blob.blast.fun/pictures/5f2c.webp", "https://evil.example/profile_images/1/AbCd_normal.jpg", "data:image/png;base64,iVBORw0KGgo="]) {
    assert.deepEqual(avatarImageSources(url), [url]);
  }
});

test("the profile, shell, presale and post avatars each first request the original, never a size suffix", () => {
  const profile = renderToStaticMarkup(<ProfileAvatar seed="kai" size={89} url={PHOTO} />);
  assert.ok(profile.includes(`src="${ORIGINAL}"`), profile);
  assert.doesNotMatch(profile, SIZE_SUFFIX);
  assert.doesNotMatch(profile, /srcset|sizes/i);
  for (const html of [
    renderToStaticMarkup(<ShellAvatar viewer={{ accountId: "kai", avatarUrl: PHOTO }} size={34} />),
    renderToStaticMarkup(<PersonAvatar person={{ callsign: "kai", avatar_url: PHOTO }} size={18} />),
    renderToStaticMarkup(<PostAvatar callsign="kai" size={30} src={PHOTO} />),
  ]) {
    assert.ok(html.includes(`src="${ORIGINAL}"`), html);
    assert.doesNotMatch(html, SIZE_SUFFIX);
    assert.doesNotMatch(html, /srcset|sizes/i);
  }
  // A picture Blast stores itself renders as before.
  assert.doesNotMatch(renderToStaticMarkup(<ProfileAvatar seed="kai" size={89} url="https://blob.blast.fun/p.webp" />), /srcset|sizes/i);
});

test("missing and unsafe avatar URLs still render the generated default", () => {
  for (const avatarUrl of [null, "http://pbs.twimg.com/profile_images/1/photo_normal.jpg", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4="]) {
    const avatar = renderToStaticMarkup(<AccountAvatar accountId="kai" avatarUrl={avatarUrl} size={89} />);
    assert.match(avatar, /data-avatar="generated"/);
    assert.doesNotMatch(avatar, /<img/);
  }
});

test("every avatar wrapper draws the authoritative edition, even when the photo is missing", () => {
  const crews = [7, 42, 88, 142, 188, 263, 455, 812, 2451, 69, 123, 256, 503, 727];
  assert.equal(crews.length, CARD_EDITIONS.length);
  for (const crew of crews) {
    const client = createTestQueryClient();
    const edition = cardEditionForCrew(crew);
    client.setQueryData(cardIdentityKey("kai"), { crew, edition, published_card_id: null });
    const wrappers = [
      <AccountAvatar accountId="kai" avatarUrl={null} key="account" size={24} />,
      <ProfileAvatar key="profile" seed="kai" size={89} url={PHOTO} />,
      <PostAvatar callsign="kai" key="post" size={26} src={PHOTO} />,
      <PersonAvatar key="presale" person={{ callsign: "kai", avatar_url: PHOTO }} size={18} />,
      <ShellAvatarRenderer key="shell" value={renderAccountAvatar}>
        <ShellAvatar viewer={{ accountId: "account-uuid", callsign: "kai", avatarUrl: PHOTO }} size={34} />
      </ShellAvatarRenderer>,
    ];
    for (const wrapper of wrappers) {
      const html = renderToStaticMarkup(<QueryProvider client={client}>{wrapper}</QueryProvider>);
      assert.match(html, new RegExp(`data-card-edition="${edition}"`));
      assert.ok(html.includes(`/social/card-rings/${edition}.svg`));
    }
    client.clear();
  }
});

test("the standalone shell avatar renders without account data", () => {
  const html = renderToStaticMarkup(<ShellAvatar viewer={{ accountId: "kai", avatarUrl: null }} size={34} />);
  assert.match(html, /data-avatar="generated"/);
  assert.doesNotMatch(html, /data-card-edition/);
});

test("generated defaults use stable colorful gradients across the profile and feed", () => {
  const account = renderToStaticMarkup(<AccountAvatar accountId="kai" avatarUrl={null} />);
  const feed = renderToStaticMarkup(<PostAvatar callsign="kai" src={null} />);
  const colors = (html: string) => [...html.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(colors(account).length, 2);
  assert.deepEqual(colors(account), colors(feed));
  assert.notDeepEqual(colors(account), colors(renderToStaticMarkup(<AccountAvatar accountId="luca" avatarUrl={null} />)));
  assert.doesNotMatch(account, /crispEdges|<img/);
});
