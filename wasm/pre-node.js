Module.preRun = [() => { for (const k in process.env) ENV[k] = process.env[k]; }];
