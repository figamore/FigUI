import assert from 'node:assert/strict'
import { formatUi } from '../src/lib/i18n'

assert.equal(formatUi('{action}: {axis}, {axis}', { axis: 'X', action: 'Mover' }), 'Mover: X, X')
assert.equal(formatUi('{axis}', { axis: '{action}' }), '{action}', 'values are not interpreted as templates')
assert.equal(formatUi('{missing}', {}), '{missing}')
assert.equal(formatUi('{constructor}', {}), '{constructor}', 'prototype properties are not values')
console.log('UI interpolation checks passed')
