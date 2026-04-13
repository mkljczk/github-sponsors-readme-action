import {ActionInterface} from './constants'
import {JSDOM} from 'jsdom'
import DOMPurify from 'dompurify'

/**
 * Defines the a new virtual DOM.
 */
const {window} = new JSDOM('')

/**
 * Sanitizes the input.
 */
const {sanitize} = DOMPurify(window)

/**
 * Utility function that checks to see if a value is undefined or not.
 */
export const isNullOrUndefined = (value: string | undefined | null): boolean =>
  typeof value === 'undefined' || value === null || value === ''

/**
 * Parses PAT input into a list of usable tokens.
 */
export const parseTokens = (tokenInput?: string): string[] => {
  if (isNullOrUndefined(tokenInput)) {
    return []
  }

  const tokens = tokenInput!
    .replace(/\r/g, '\n')
    .split(/[\n,]/)
    .map(token => token.trim())
    .filter(token => !isNullOrUndefined(token))

  return [...new Set(tokens)]
}

/**
 * Verifies the action has the required parameters to run, otherwise throw an error.
 */
export const checkParameters = (action: ActionInterface): void => {
  if (!parseTokens(action.token).length) {
    throw new Error(
      'No deployment token was provided. You must provide the action with a Personal Access Token scoped to user:read and org:read.'
    )
  }
}

/**
 * Replaces all instances of a match in a string.
 */
export const replaceAll = (
  input: string,
  find: string,
  replace: string
): string => input.split(find).join(replace)

/**
 * Suppresses sensitive information from being exposed in error messages.
 */
export const suppressSensitiveInformation = (
  str: string,
  action: ActionInterface
): string => {
  let value = str

  const orderedByLength = parseTokens(action.token).sort(
    (a, b) => b.length - a.length
  )

  for (const find of orderedByLength) {
    value = replaceAll(value, find, '***')
  }

  return value
}

/**
 * Extracts error message from an error.
 */
export const extractErrorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error == 'string'
      ? error
      : JSON.stringify(error)

/**
 * Sanitizes and cleans an input.
 */
export const sanitizeAndClean = (input: string): string => {
  const sanitizedInput = sanitize(input, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: []
  })

  return sanitizedInput.replace(/["'<>]/g, '')
}
