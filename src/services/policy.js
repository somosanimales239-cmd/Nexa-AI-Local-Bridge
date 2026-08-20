'use strict';

class BridgePolicy {
  constructor() {
    this.reset();
  }

  reset() {
    this.authenticated = false;
    this.bridgeEnabled = false;
    this.emergencyStop = false;
    this.fullComputerMode = false;
    this.permissions = Object.freeze({
      read_files: false,
      write_files: false,
      cmd: false,
      powershell: false,
      python: false,
      git: false,
      browser: false,
      screenshots: false,
      blender: false,
      local_servers: false,
    });
  }

  applyServerState(server) {
    this.authenticated = true;
    this.bridgeEnabled = server.bridge_enabled === true;
    this.emergencyStop = server.emergency_stop === true;
    this.fullComputerMode = server.full_computer_mode === true;

    const incoming = server.permissions && typeof server.permissions === 'object'
      ? server.permissions
      : {};

    const next = {};
    for (const key of Object.keys(this.permissions)) {
      next[key] = incoming[key] === true;
    }
    this.permissions = Object.freeze(next);
  }

  markDisconnected() {
    this.authenticated = false;
  }

  canExecute(capabilityName) {
    return Boolean(
      this.authenticated &&
      this.bridgeEnabled &&
      !this.emergencyStop &&
      this.permissions[capabilityName] === true
    );
  }

  snapshot() {
    return {
      authenticated: this.authenticated,
      bridgeEnabled: this.bridgeEnabled,
      emergencyStop: this.emergencyStop,
      fullComputerMode: this.fullComputerMode,
      permissions: { ...this.permissions },
    };
  }
}

module.exports = { BridgePolicy };
