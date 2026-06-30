/**
 * JSON-RPC 2.0 message utilities for IPC with C# service
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Create a JSON-RPC request
 * @param {string} method - Method name
 * @param {object} params - Method parameters
 * @returns {string} JSON string
 */
function createRequest(method, params = null) {
  const request = {
    jsonrpc: '2.0',
    id: uuidv4(),
    method,
    params
  };
  return JSON.stringify(request);
}

/**
 * Create a JSON-RPC notification (no response expected)
 * @param {string} method - Method name
 * @param {object} params - Method parameters
 * @returns {string} JSON string
 */
function createNotification(method, params = null) {
  const notification = {
    jsonrpc: '2.0',
    method,
    params
  };
  return JSON.stringify(notification);
}

/**
 * Parse a JSON-RPC response
 * @param {string} json - JSON string
 * @returns {object} Parsed response with result or error
 */
function parseResponse(json) {
  const response = JSON.parse(json);

  if (response.error) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    error.data = response.error.data;
    throw error;
  }

  return {
    id: response.id,
    result: response.result
  };
}

/**
 * Check if message is a notification (no id)
 * @param {object} message - Parsed JSON message
 * @returns {boolean}
 */
function isNotification(message) {
  return message.jsonrpc === '2.0' && message.method && !message.id;
}

/**
 * Parse message as notification
 * @param {string} json - JSON string
 * @returns {object|null} Notification or null
 */
function parseNotification(json) {
  try {
    const message = JSON.parse(json);
    if (isNotification(message)) {
      return {
        method: message.method,
        params: message.params
      };
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  createRequest,
  createNotification,
  parseResponse,
  parseNotification,
  isNotification
};
