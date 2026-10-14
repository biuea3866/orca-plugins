import { test } from 'node:test'
import assert from 'node:assert/strict'
import { armConfirm } from '../ui/lib/confirm.mjs'

function fakeButton(label = '삭제') {
  return { dataset: {}, textContent: label, title: '' }
}

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimer: (callback, ms) => { timers.push({ callback, ms, cleared: false }); return timers.length - 1 },
    clearTimer: (id) => { if (timers[id]) timers[id].cleared = true }
  }
}

test('the first click only arms the button, it never runs the action', () => {
  const button = fakeButton()
  const { setTimer, clearTimer, timers } = fakeTimers()
  let confirmed = 0
  const result = armConfirm(button, { message: '코멘트를 삭제할까요?', onConfirm: () => { confirmed += 1 }, setTimer, clearTimer })
  assert.equal(result, 'armed')
  assert.equal(confirmed, 0)
  assert.equal(button.textContent, '정말 삭제')
  assert.equal(button.title, '코멘트를 삭제할까요?')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 4000)
})

test('the second click runs the action once and restores the button', () => {
  const button = fakeButton('삭제')
  const { setTimer, clearTimer, timers } = fakeTimers()
  let confirmed = 0
  const options = { onConfirm: () => { confirmed += 1 }, setTimer, clearTimer }
  armConfirm(button, options)
  const result = armConfirm(button, options)
  assert.equal(result, 'confirmed')
  assert.equal(confirmed, 1)
  assert.equal(button.textContent, '삭제')
  assert.equal(timers[0].cleared, true, 'the disarm timer is cancelled')
})

test('an armed button disarms itself after the timeout, so a later click arms again instead of deleting', () => {
  const button = fakeButton('삭제')
  const { setTimer, clearTimer, timers } = fakeTimers()
  let confirmed = 0
  const options = { onConfirm: () => { confirmed += 1 }, setTimer, clearTimer }
  armConfirm(button, options)
  timers[0].callback()
  assert.equal(button.textContent, '삭제')
  assert.equal(armConfirm(button, options), 'armed')
  assert.equal(confirmed, 0)
})

test('a custom armed label is shown and the original label comes back', () => {
  const button = fakeButton('완료')
  const { setTimer, clearTimer } = fakeTimers()
  const options = { armedLabel: '열린 2개 · 그래도 완료', onConfirm: () => {}, setTimer, clearTimer }
  armConfirm(button, options)
  assert.equal(button.textContent, '열린 2개 · 그래도 완료')
  armConfirm(button, options)
  assert.equal(button.textContent, '완료')
})

test('without an onConfirm callback the result tells the caller whether to proceed', () => {
  const button = fakeButton()
  const { setTimer, clearTimer } = fakeTimers()
  assert.equal(armConfirm(button, { setTimer, clearTimer }), 'armed')
  assert.equal(armConfirm(button, { setTimer, clearTimer }), 'confirmed')
})
