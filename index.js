const request = require('request');
const moment = require('moment');
const debug = require('debug')('homebridge-minimal-http-blinds');

const CustomCharacteristics = require('./custom-characteristics');

let Service;
let Characteristic;

/**
 * About WindowCover position: 100 is fully open, 0 is fully closed
 */
class MinimalisticHttpBlinds {
  constructor(log, config) {
    this.log = log;
    this.name = config.name;

    // Required parameters
    this.getCurrentPositionUrl = config.get_current_position_url || '';
    this.setTargetPositionUrl = config.set_target_position_url || '';
    this.getBatteryUrl = config.get_battery_level_url || false;

    // Optional parameters: HTTP methods
    this.getCurrentPositionMethod = config.get_current_position_method || 'GET';
    this.setTargetPositionMethod = config.set_target_position_method || 'POST';

    // Optional parameters: polling times
    this.currentPositionPollingInterval =
      parseInt(config.get_current_position_polling_millis, 10) || 500;

    // Optional parameter: tolerance
    this.currentPositionTolerance = config.current_position_tolerance || 0;

    // Internal fields
    this.lastKnownPosition = null;
    this.currentPositionTimer = null;

    this.targetPosition = null;

    this.lastKnownBatteryLevel = null;

    this.lastPositionUpdateTimestamp = null;
    this.lastPositionUpdateStatus = 'n/a';

    this.windowCoveringService = new Service.WindowCovering(this.name);

    this.windowCoveringService
      .getCharacteristic(Characteristic.CurrentPosition)
      .on('get', this.getCurrentPosition.bind(this));

    this.windowCoveringService
      .getCharacteristic(Characteristic.TargetPosition)
      .on('get', this.getTargetPosition.bind(this))
      .on('set', this.setTargetPosition.bind(this));

    this.windowCoveringService
      .addCharacteristic(CustomCharacteristics.LastCheckTimestamp)
      .on('get', callback => callback(null, this.formatLastUpdateTimestamp()));

    this.windowCoveringService
      .addCharacteristic(CustomCharacteristics.LastCheckStatus)
      .on('get', callback => callback(null, this.lastPositionUpdateStatus));

    // Initialise accessories, update both CurrentPosition and TargetPosition
    this.currentPositionTimerAction(true);
    this.log(`Polling blind state every ${this.currentPositionPollingInterval}ms`);

    this.batteryService = null;
    if (this.getBatteryUrl) {
      debug('Including battery service');

      this.batteryService = new Service.BatteryService('Battery level');

      this.batteryService
        .getCharacteristic(Characteristic.BatteryLevel)
        .on('get', callback => callback(null, this.lastKnownBatteryLevel));

      this.batteryService
        .getCharacteristic(Characteristic.ChargingState)
        .on('get', callback => callback(null, Characteristic.ChargingState.NOT_CHARGING));

      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .on('get', this.getStatusLowBattery.bind(this));
    }
  }

  getServices() {
    if (this.batteryService) {
      return [this.windowCoveringService, this.batteryService];
    }

    return [this.windowCoveringService];
  }

  calculateStatusLowBattery() {
    if (this.lastKnownBatteryLevel > 20) {
      return Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    return Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
  }

  getStatusLowBattery(callback) {
    callback(this.calculateStatusLowBattery());
  }

  getCurrentPosition(callback) {
    callback(null, this.lastKnownPosition);
  }

  updateBatteryLevel(level) {
    this.lastKnownBatteryLevel = level;

    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .updateValue(this.lastKnownBatteryLevel);

    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .updateValue(this.calculateStatusLowBattery());
  }

  startCurrentPositionTimer() {
    this.stopCurrentPositionTimer();

    this.currentPositionTimer = setTimeout(
      this.currentPositionTimerAction.bind(this),
      this.currentPositionPollingInterval,
    );
  }

  fetchBatteryLevel() {
    request(
      {
        url: this.getBatteryUrl,
        method: 'GET',
        timeout: 15000,
      },
      (error, response, body) => {
        if (error) {
          this.log(`Error in getting battery level: ${body ? body.replace(/(?:\r\n|\r|\n)/g, '') : ''} -- ${error.toString()}`);
          return;
        }

        const level = parseInt(body, 10);

        if (isNaN(level)) { // eslint-disable-line
          this.log(`Error in getting battery level: ${body ? body.replace(/(?:\r\n|\r|\n)/g, '') : ''}`);
        } else {
          debug(`Battery level fetched: ${level}`);
          this.updateBatteryLevel(level);
        }
      },
    );
  }

  refreshLastUpdate() {
    this.windowCoveringService
      .getCharacteristic(CustomCharacteristics.LastCheckTimestamp)
      .updateValue(this.formatLastUpdateTimestamp());

    this.windowCoveringService
      .getCharacteristic(CustomCharacteristics.LastCheckStatus)
      .updateValue(this.lastPositionUpdateStatus);
  }

  formatLastUpdateTimestamp() {
    return this.lastPositionUpdateTimestamp ? this.lastPositionUpdateTimestamp.fromNow() : 'n/a';
  }

  currentPositionTimerAction(updateTargetPosition) {
    request(
      {
        url: this.getCurrentPositionUrl,
        method: this.getCurrentPositionMethod,
        timeout: 15000,
      },
      (error, response, body) => {
        this.lastPositionUpdateTimestamp = moment();
        this.lastPositionUpdateStatus = 'Failed';

        if (error) {
          this.log(`Error in getting current position: ${body ? body.replace(/(?:\r\n|\r|\n)/g, '') : ''} -- ${error.toString()}`);
          this.startCurrentPositionTimer();
          return;
        }

        const position = parseInt(body, 10);

        if (isNaN(position)) { // eslint-disable-line
          this.log(`Error in getting current position: ${body ? body.replace(/(?:\r\n|\r|\n)/g, '') : ''}`);
        } else {
          this.lastPositionUpdateStatus = 'Successful';
          debug(`Current position fetched: ${position}`);
          this.setLastKnownPosition(position);

          if (updateTargetPosition) {
            this.windowCoveringService
              .getCharacteristic(Characteristic.TargetPosition)
              .updateValue(position);
          }
        }

        if (this.getBatteryUrl) {
          this.fetchBatteryLevel();
        }
        this.refreshLastUpdate();
        this.startCurrentPositionTimer();
      },
    );
  }

  stopCurrentPositionTimer() {
    if (this.currentPositionTimer) {
      clearTimeout(this.currentPositionTimer);
    }
  }

  static getPositionDescription(value) {
    if (value === 100) {
      return 'open';
    } else if (value === 0) {
      return 'closed';
    } else if (value === 50) {
      return 'half open';
    }

    return `${value}%`;
  }

  setLastKnownPosition(value) {
    if (isNaN(value)) { // eslint-disable-line
      this.log(`Error setting current position: ${value}`);
      return;
    }

    let returnedValue = value;

    if (this.lastKnownPosition !== value) {
      if (this.lastKnownPosition === null) {
        this.log(`Setting initial position: ${this.constructor.getPositionDescription(value)}`);
      } else {
        this.log(`Blind has moved, new position: ${this.constructor.getPositionDescription(value)}`);
      }

      // Override the current position to account for tolerance
      const positionDifference = Math.abs(this.targetPosition - value);
      if (positionDifference <= this.currentPositionTolerance) {
        returnedValue = this.targetPosition;
      }

      this.windowCoveringService
        .getCharacteristic(Characteristic.CurrentPosition)
        .updateValue(returnedValue);
    }

    this.lastKnownPosition = returnedValue;
  }

  getTargetPosition(callback) {
    callback(null, this.targetPosition);
  }

  setTargetPosition(position, callback) {
    this.targetPosition = position;

    this.log(`Requested new position: ${this.constructor.getPositionDescription(position)}`);
    this.stopCurrentPositionTimer();

    request(
      {
        url: this.setTargetPositionUrl.replace('%position%', position),
        method: this.setTargetPositionMethod,
        timeout: 15000,
      },
      (error, response, body) => {
        if (error) {
          this.log(`Error setting the new position: ${body} -- ${error.toString()}`);
          return;
        }

        this.setLastKnownPosition(position);
        this.startCurrentPositionTimer();
        callback(null);
      },
    );
  }
}

module.exports = (homebridge) => {
  Service = homebridge.hap.Service; // eslint-disable-line
  Characteristic = homebridge.hap.Characteristic; // eslint-disable-line
  homebridge.registerAccessory('homebridge-minimal-http-blinds', 'MinimalisticHttpBlinds', MinimalisticHttpBlinds);
};
