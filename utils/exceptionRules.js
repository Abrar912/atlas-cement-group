'use strict';

/**
 * PHASE 20B — Locked exception rules.
 * Deterministic, unit-testable, NO database access, NO writes.
 * Owner decisions D-2 (default treatments) and locked rules 23-27.
 */

const REASONS = [
  'PUBLIC_HOLIDAY',
  'COMPANY_CLOSURE',
  'EMERGENCY',
  'DEVICE_PROBLEM',
  'APPROVED_ABSENCE',
  'UNEXCUSED_ABSENCE',
  'CORRECTED_ATTENDANCE',
  'OTHER'
];

const TREATMENTS = [
  'PAID_NO_DEDUCTION',
  'NO_PAYROLL_EFFECT',
  'UNPAID_DEDUCT',
  'FOLLOW_CORRECTED'
];

const STATUSES = ['PENDING', 'RESOLVED'];

// D-2: locked default treatment per reason (admin may override with any of the 4).
const DEFAULT_TREATMENTS = {
  PUBLIC_HOLIDAY: 'PAID_NO_DEDUCTION',
  COMPANY_CLOSURE: 'PAID_NO_DEDUCTION',
  EMERGENCY: 'PAID_NO_DEDUCTION',
  DEVICE_PROBLEM: 'PAID_NO_DEDUCTION',
  APPROVED_ABSENCE: 'PAID_NO_DEDUCTION',
  OTHER: 'PAID_NO_DEDUCTION',
  UNEXCUSED_ABSENCE: 'UNPAID_DEDUCT',
  CORRECTED_ATTENDANCE: 'FOLLOW_CORRECTED'
};

function isValidReason(value) {
  return REASONS.includes(value);
}

function isValidTreatment(value) {
  return TREATMENTS.includes(value);
}

function isValidStatus(value) {
  return STATUSES.includes(value);
}

function defaultTreatmentFor(reason) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TREATMENTS, reason)
    ? DEFAULT_TREATMENTS[reason]
    : null;
}

// Rule 25: PENDING -> RESOLVED only. Rule 26: RESOLVED -> PENDING forbidden.
function canUpdatePending(status) {
  return status === 'PENDING';
}

function canResolve(status) {
  return status === 'PENDING';
}

function canReclassify(status) {
  return status === 'RESOLVED';
}

module.exports = {
  REASONS,
  TREATMENTS,
  STATUSES,
  DEFAULT_TREATMENTS,
  isValidReason,
  isValidTreatment,
  isValidStatus,
  defaultTreatmentFor,
  canUpdatePending,
  canResolve,
  canReclassify
};
