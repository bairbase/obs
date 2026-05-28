const Module = require('module');
const originalRequire = Module.prototype.require;
class DummyPlugin {}
class DummyModal {}
class DummyView {}
class DummySettingTab {}
Module.prototype.require = function(arg) {
  if (arg === 'obsidian') return { Plugin: DummyPlugin, Modal: DummyModal, TextFileView: DummyView, ItemView: DummyView, PluginSettingTab: DummySettingTab };
  if (arg.startsWith('@codemirror') || arg.startsWith('@lezer') || arg.startsWith('prosemirror')) return new Proxy({}, { get: () => function() {} });
  return originalRequire.apply(this, arguments);
};
try {
  const pkg = require('./main.js');
  console.log('Export keys:', Object.keys(pkg));
  console.log('Default export:', typeof pkg.default);
} catch(e) {
  console.error('Error during require:', e.stack);
}
