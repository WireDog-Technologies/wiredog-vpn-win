#!/usr/bin/env node

/**
 * Development launcher for WireDog VPN Electron app
 * This script ensures proper startup order and error handling
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 Starting WireDog VPN Electron Development Environment...\n');

// Check if we're in the right directory
const packageJsonPath = path.join(__dirname, '..', 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  console.error('❌ Error: package.json not found. Please run from project root.');
  process.exit(1);
}

// Check if dependencies are installed
const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.error('❌ Error: node_modules not found. Please run "npm install" first.');
  process.exit(1);
}

console.log('✅ Dependencies verified');
console.log('✅ Starting development servers...\n');

// Start the development process with concurrently
const concurrently = spawn('node', ['node_modules/.bin/concurrently', 'npm:dev:vite', 'npm:dev:electron'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: true
});

concurrently.on('close', (code) => {
  console.log(`\n📴 Development environment stopped (exit code: ${code})`);
  process.exit(code);
});

concurrently.on('error', (error) => {
  console.error('❌ Failed to start development environment:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down development environment...');
  concurrently.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down development environment...');
  concurrently.kill('SIGTERM');
});