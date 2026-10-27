const ts = require("typescript"); // eslint-disable-line @typescript-eslint/no-require-imports

module.exports = function compileTsx(source) {
  const result = ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  this.callback(null, result.outputText);
};
