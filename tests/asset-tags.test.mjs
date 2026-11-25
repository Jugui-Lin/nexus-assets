import assert from 'node:assert/strict';
import test from 'node:test';
import {buildTagTree, matchesTag} from '../public/asset-tags.js';

test('hierarchical tags keep root tags and filter descendants by their full prefix', () => {
  const assets = [
    {tags: ['家具', '家具/座椅', '家具/桌子', '材质/织物']},
    {tags: ['家具/座椅/窄椅', '家具套装']},
  ];
  const furniture = buildTagTree(assets).children.get('家具');
  assert.equal(furniture.tag, '家具');
  assert.equal(furniture.children.get('座椅').children.get('窄椅').tag, '家具/座椅/窄椅');
  assert.equal(matchesTag(assets[0].tags, '家具/'), true);
  assert.equal(matchesTag(assets[1].tags, '家具/座椅/'), true);
  assert.equal(matchesTag(['家具套装'], '家具/'), false);
  assert.equal(buildTagTree(assets, '窄椅').children.has('材质'), false);
});
