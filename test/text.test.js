import assert from 'node:assert/strict';
import test from 'node:test';
import { inOtherAlphabet, removeFillers } from '../src/text.js';

test('removes filler words and the pause commas around them', () => {
  assert.equal(removeFillers('Uh, I think, uh, you can make it faster.'), 'I think you can make it faster.');
  assert.equal(removeFillers('Okay uh.'), 'Okay.');
  assert.equal(removeFillers('Hmm, okay'), 'Okay');
  assert.equal(removeFillers('Umm... so'), 'So');
  assert.equal(removeFillers('um'), '');
  assert.equal(removeFillers('Э, ну это, ээ, работает.'), 'Ну это работает.');
});

test('keeps words that only look like fillers', () => {
  assert.equal(removeFillers('This umbrella is humming.'), 'This umbrella is humming.');
  assert.equal(removeFillers('He said uh-huh.'), 'He said uh-huh.');
  assert.equal(removeFillers('Apples, oranges, um and pears.'), 'Apples, oranges, and pears.');
  assert.equal(removeFillers('one, two, um, three'), 'one, two, three');
  assert.equal(removeFillers('The UM is a university.'), 'The UM is a university.');
  assert.equal(removeFillers('Say "um" twice'), 'Say "um" twice');
});

test('finds letters from another alphabet than the language\'s own', () => {
  assert.equal(inOtherAlphabet('Тестинг', 'en'), true);
  assert.equal(inOtherAlphabet('Testing, 1 2 3!', 'en'), false);
  assert.equal(inOtherAlphabet('Grüße, ça va', 'de'), false);
  assert.equal(inOtherAlphabet('Привет', 'uk'), false);
  assert.equal(inOtherAlphabet('Hello', 'ru'), true);
  assert.equal(inOtherAlphabet('Καλημέρα', 'el'), false);
});
