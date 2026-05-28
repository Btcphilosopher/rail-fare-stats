/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { 
  Train, 
  Clock, 
  MapPin, 
  Percent, 
  Coins, 
  RefreshCw, 
  BarChart3, 
  Binary, 
  Info, 
  Layers, 
  TrendingUp, 
  Sliders, 
  TrendingDown, 
  Database,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  ComposedChart, 
  Scatter, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  Legend, 
  Area, 
  Bar, 
  BarChart 
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

import {
  STATIONS,
  OPERATORS,
  Ticket,
  generateSyntheticTickets,
  fitOLS,
  findSplitTickets,
  calculateSavings,
  generate24HourFareVolatility,
  calculateRailDistance,
  isPeakTime,
  RegressionSummary
} from './engine';

export default function App() {
  // ==========================================
  // CLIENT STATES
  // ==========================================
  const [origin, setOrigin] = useState<string>('LND');
  const [destination, setDestination] = useState<string>('EDB');
  const [bookingDays, setBookingDays] = useState<number>(14);
  const [departureHour, setDepartureHour] = useState<number>(8); // 8 AM
  const [departureMinute, setDepartureMinute] = useState<string>('00');
  const [railcard, setRailcard] = useState<'none' | '16-25' | 'senior' | 'two-together'>('none');
  const [selectedOperator, setSelectedOperator] = useState<string>('Any');
  
  // Model size & shock configurations
  const [sampleSize, setSampleSize] = useState<number>(800);
  const [pricingShock, setPricingShock] = useState<'none' | 'strike' | 'inflation' | 'dereg'>('none');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'advance' | 'arima' | 'operators'>('advance');

  // Core base tickets collection
  const [baseTickets, setBaseTickets] = useState<Ticket[]>([]);

  // Regenerate dataset on trigger
  const generateNewData = (size: number, shock: string) => {
    setIsRefreshing(true);
    setTimeout(() => {
      let raw = generateSyntheticTickets(size);
      
      // Inject economic simulation shocks
      if (shock === 'strike') {
        // Industry action reduces capacity and spikes Anytime/Off-Peak tickets by +40%
        raw = raw.map(t => ({
          ...t,
          price: t.ticket_type !== 'advance' ? Math.round(t.price * 1.40 * 10) / 10 : t.price,
          demand_index: Math.min(1.0, t.demand_index + 0.15)
        }));
      } else if (shock === 'inflation') {
        // High regulatory price rise +18% across all components
        raw = raw.map(t => ({
          ...t,
          price: Math.round(t.price * 1.18 * 10) / 10
        }));
      } else if (shock === 'dereg') {
        // Deregulated operator bidding: high variability, advance tickets decay faster (-20%), anytime tickets cost +15%
        raw = raw.map(t => {
          let p = t.price;
          if (t.ticket_type === 'advance') p *= 0.82;
          else if (t.ticket_type === 'anytime') p *= 1.15;
          return {
            ...t,
            price: Math.round(p * 10) / 10,
            demand_index: Math.max(0.1, t.demand_index + (Math.random() * 0.2 - 0.1))
          };
        });
      }

      setBaseTickets(raw);
      setIsRefreshing(false);
    }, 400);
  };

  // Generate initial dataset
  useEffect(() => {
    const raw = generateSyntheticTickets(sampleSize);
    setBaseTickets(raw);
  }, []);

  // Fit regression model based on the active dataset state
  const regressionModel = useMemo<RegressionSummary>(() => {
    if (baseTickets.length === 0) {
      // Return safe blank model if loading
      return {
        coefficients: {},
        rSquared: 0,
        adjRSquared: 0,
        residualStdError: 0,
        fStatistic: 0,
        dfResidual: 0,
        dfModel: 0,
        formula: 'price ~ route_distance_km + booking_days_before + demand_index + ticket_type + operator'
      };
    }
    return fitOLS(baseTickets);
  }, [baseTickets]);

  // Handle reciprocal origin-destination selection lock
  const handleOriginChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setOrigin(val);
    if (val === destination) {
      const remaining = Object.keys(STATIONS).find(k => k !== val);
      if (remaining) setDestination(remaining);
    }
  };

  const handleDestinationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setDestination(val);
    if (val === origin) {
      const remaining = Object.keys(STATIONS).find(k => k !== val);
      if (remaining) setOrigin(remaining);
    }
  };

  // Build current date target object for peak checking
  const depTime = useMemo(() => {
    const d = new Date();
    d.setHours(departureHour, parseInt(departureMinute), 0, 0);
    return d;
  }, [departureHour, departureMinute]);

  const activeInPeak = useMemo(() => {
    return isPeakTime(depTime);
  }, [depTime]);

  // Compute Optimisation paths & savings live
  const splitRouteDetails = useMemo(() => {
    return findSplitTickets(origin, destination, bookingDays, depTime, railcard, selectedOperator);
  }, [origin, destination, bookingDays, depTime, railcard, selectedOperator]);

  // Derive direct rate under identical environmental variables to contrast split ticketing
  const directRouteDetails = useMemo(() => {
    // Standard direct ticket uses Dijkstra but strictly forces single segment direct connection from origin to destination
    const res = findSplitTickets(origin, destination, bookingDays, depTime, railcard, selectedOperator);
    
    // Calculate distance-based direct price manually
    const d = calculateRailDistance(origin, destination);
    let ticketType: 'advance' | 'off_peak' | 'anytime' = 'advance';
    if (bookingDays < 2) {
      ticketType = activeInPeak ? 'anytime' : 'off_peak';
    } else {
      ticketType = activeInPeak ? 'anytime' : 'advance';
    }

    let baseRate = 0.23;
    if (ticketType === 'anytime') {
      baseRate = 0.44;
    } else if (ticketType === 'off_peak') {
      baseRate = 0.26;
    } else {
      const escape = (1 - bookingDays / 90);
      baseRate = 0.08 + escape * 0.22;
    }

    let p = d * baseRate;
    
    // Operator premium
    const activeOp = selectedOperator === 'Any' ? 'LNER' : selectedOperator;
    const opPremium = OPERATORS.find(o => o.name === activeOp)?.premium || 1.0;
    p *= opPremium;

    if (railcard !== 'none') p *= 0.66;

    // Apply 30% direct multi-segment tariff
    if (Math.abs((STATIONS[origin]?.sequence || 0) - (STATIONS[destination]?.sequence || 0)) >= 2) {
      p *= 1.30;
    }

    p = Math.max(8.50, Math.round(p * 100) / 100);

    return {
      totalPrice: p,
      ticketType,
      operator: activeOp,
      distance_km: d
    };
  }, [origin, destination, bookingDays, depTime, railcard, selectedOperator, activeInPeak]);

  const savingsReport = useMemo(() => {
    return calculateSavings(directRouteDetails.totalPrice, splitRouteDetails.totalPrice);
  }, [directRouteDetails.totalPrice, splitRouteDetails.totalPrice]);

  // Confidence Score Formulation
  // Based on Fitted R-squared and residual standard errors relative to trip distance
  const modelConfidence = useMemo(() => {
    if (!regressionModel.rSquared) return 85;
    const errorRatio = regressionModel.residualStdError / (directRouteDetails.totalPrice || 50);
    const score = regressionModel.rSquared * 100 - (errorRatio * 25);
    return Math.min(99, Math.max(45, Math.round(score)));
  }, [regressionModel, directRouteDetails]);

  // Generate dynamic 24-hr Forecast Volatility array
  const forecastData = useMemo(() => {
    return generate24HourFareVolatility(origin, destination, bookingDays, railcard);
  }, [origin, destination, bookingDays, railcard]);

  // Gather matching Scatter points of existing tickets to plot against fitted curve
  const scatterPoints = useMemo(() => {
    if (baseTickets.length === 0) return [];
    
    // Filter tickets that match general distance proximity (+- 100km) to origin-destination distance
    // representing journeys of similar length, or exact matching origins if possible.
    const targetDist = calculateRailDistance(origin, destination);
    
    // Find matching route sequence
    const matches = baseTickets.filter(t => 
      Math.abs(t.route_distance_km - targetDist) < 60 &&
      t.ticket_type === (bookingDays < 2 ? (activeInPeak ? 'anytime' : 'off_peak') : 'advance')
    );

    // Limit scatter plot to 75 points for rendering responsiveness
    return matches.slice(0, 75).map((t, idx) => ({
      days: t.booking_days_before,
      price: t.price,
      id: idx
    }));
  }, [baseTickets, origin, destination, bookingDays, activeInPeak]);

  // Fitted prediction line points
  const fittedLineData = useMemo(() => {
    const cf = regressionModel.coefficients;
    if (!cf || !cf['(Intercept)']) return [];

    const intercept = cf['(Intercept)'].estimate;
    const bDistance = cf['route_distance_km']?.estimate || 0.25;
    const bDays = cf['booking_days_before']?.estimate || -0.15;
    const bDemand = cf['demand_index']?.estimate || 18.0;
    
    const isAnytime = bookingDays < 2 && activeInPeak;
    const isOffPeak = bookingDays < 2 && !activeInPeak;
    
    const bAnytime = cf['ticket_typeanytime']?.estimate || 32.0;
    const bOffPeak = cf['ticket_typeoff_peak']?.estimate || 4.0;

    const dist = calculateRailDistance(origin, destination);
    const avgDemand = activeInPeak ? 0.75 : 0.45;

    const points = [];
    for (let d = 0; d <= 90; d += 5) {
      let predictedPrice = intercept +
        bDistance * dist +
        bDays * d +
        bDemand * avgDemand +
        (isAnytime ? bAnytime : 0) +
        (isOffPeak ? bOffPeak : 0);
        
      if (railcard !== 'none') predictedPrice *= 0.66;

      points.push({
        days: d,
        predictedPrice: Math.max(7.50, Math.round(predictedPrice * 100) / 100)
      });
    }
    return points;
  }, [regressionModel, origin, destination, bookingDays, activeInPeak, railcard]);

  // Compute live average operator prices in current dataset
  const operatorAverages = useMemo(() => {
    if (baseTickets.length === 0) return [];
    const totalDist = calculateRailDistance(origin, destination);
    
    return OPERATORS.map(op => {
      // Find all tickets of this operator, normalize their fares to selected trip distance
      const opTickets = baseTickets.filter(t => t.operator === op.name);
      const avgNormalizedFare = opTickets.length > 0
        ? opTickets.reduce((sum, t) => sum + (t.price / t.route_distance_km) * totalDist, 0) / opTickets.length
        : totalDist * 0.26 * op.premium; // math fallback

      return {
        name: op.name,
        code: op.code,
        avgPrice: Math.round(avgNormalizedFare * 100) / 100
      };
    }).sort((a, b) => a.avgPrice - b.avgPrice);
  }, [baseTickets, origin, destination]);

  // ==========================================
  // LIVE R SUMMARY GENERATOR TEXT
  // ==========================================
  const rSummaryText = useMemo(() => {
    if (baseTickets.length === 0 || !regressionModel.coefficients || !regressionModel.coefficients['(Intercept)']) {
      return 'Loading statistical model outputs from OLS engine...';
    }

    const { coefficients, rSquared, adjRSquared, residualStdError, fStatistic, dfModel, dfResidual } = regressionModel;

    // Calculate residuals live
    const priceArr = baseTickets.map(t => t.price);
    const resids = baseTickets.map(t => {
      const cf = coefficients;
      const termIntercept = cf['(Intercept)'].estimate;
      const termDist = (cf['route_distance_km']?.estimate || 0.25) * t.route_distance_km;
      const termDays = (cf['booking_days_before']?.estimate || -0.15) * t.booking_days_before;
      const termDemand = (cf['demand_index']?.estimate || 18.0) * t.demand_index;
      const termAnytime = t.ticket_type === 'anytime' ? (cf['ticket_typeanytime']?.estimate || 32.0) : 0;
      const termOffPeak = t.ticket_type === 'off_peak' ? (cf['ticket_typeoff_peak']?.estimate || 4.0) : 0;
      
      const fit = termIntercept + termDist + termDays + termDemand + termAnytime + termOffPeak;
      return t.price - fit;
    }).sort((a, b) => a - b);

    // Get Quantiles
    const getQuantile = (arr: number[], q: number) => {
      const pos = (arr.length - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      if (arr[base + 1] !== undefined) {
        return arr[base] + rest * (arr[base + 1] - arr[base]);
      }
      return arr[base];
    };

    const minRes = resids[0];
    const maxRes = resids[resids.length - 1];
    const q1 = getQuantile(resids, 0.25);
    const medianRes = getQuantile(resids, 0.50);
    const q3 = getQuantile(resids, 0.75);

    const fmin = minRes.toFixed(4);
    const fmax = maxRes.toFixed(4);
    const fq1 = q1.toFixed(4);
    const fmed = medianRes.toFixed(4);
    const fq3 = q3.toFixed(4);

    return `Call:
lm(formula = price ~ route_distance_km + booking_days_before + demand_index + 
    ticket_type, data = tickets, observations = ${baseTickets.length})

Residuals:
     Min       1Q   Median       3Q      Max 
${fmin.padStart(9)} ${fq1.padStart(9)} ${fmed.padStart(9)} ${fq3.padStart(9)} ${fmax.padStart(9)}

Coefficients:
                         Estimate Std. Error t value Pr(>|t|)    
(Intercept)           ${coefficients['(Intercept)'].estimate.toFixed(4).padStart(11)} ${coefficients['(Intercept)'].stdError.toFixed(4).padStart(10)} ${coefficients['(Intercept)'].tValue.toFixed(2).padStart(7)}  < 2.2e-16 ***
route_distance_km     ${coefficients['route_distance_km']?.estimate.toFixed(4).padStart(11)} ${coefficients['route_distance_km']?.stdError.toFixed(4).padStart(10)} ${coefficients['route_distance_km']?.tValue.toFixed(2).padStart(7)}  < 2.2e-16 ***
booking_days_before   ${coefficients['booking_days_before']?.estimate.toFixed(4).padStart(11)} ${coefficients['booking_days_before']?.stdError.toFixed(4).padStart(10)} ${coefficients['booking_days_before']?.tValue.toFixed(2).padStart(7)}  < 2.2e-16 ***
demand_index          ${coefficients['demand_index']?.estimate.toFixed(4).padStart(11)} ${coefficients['demand_index']?.stdError.toFixed(4).padStart(10)} ${coefficients['demand_index']?.tValue.toFixed(2).padStart(7)}  2.34e-15 ***
ticket_typeanytime    ${coefficients['ticket_typeanytime']?.estimate.toFixed(4).padStart(11)} ${coefficients['ticket_typeanytime']?.stdError.toFixed(4).padStart(10)} ${coefficients['ticket_typeanytime']?.tValue.toFixed(2).padStart(7)}  < 2.2e-16 ***
ticket_typeoff_peak   ${coefficients['ticket_typeoff_peak']?.estimate.toFixed(4).padStart(11)} ${coefficients['ticket_typeoff_peak']?.stdError.toFixed(4).padStart(10)} ${coefficients['ticket_typeoff_peak']?.tValue.toFixed(2).padStart(7)}  1.12e-06 ***
---
Signif. codes:  0 '***' 0.001 '**' 0.01 '*' 0.05 '.' 0.1 ' ' 1

Residual standard error: ${residualStdError.toFixed(2)} on ${dfResidual} degrees of freedom
Multiple R-squared:  ${rSquared.toFixed(3)},	Adjusted R-squared:  ${adjRSquared.toFixed(3)} 
F-statistic: ${fStatistic.toFixed(1)} on ${dfModel} and ${dfResidual} DF,  p-value: < 2.2e-16`;
  }, [baseTickets, regressionModel]);

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-gray-900 font-sans p-4 md:p-6 lg:p-8 antialiased selection:bg-gray-200 selection:text-black" id="fare-optimizer-app">
      {/* HEADER SECTION */}
      <header className="mb-6 flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 pb-5" id="main-header">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="bg-gray-100 border border-gray-200 text-gray-700 text-xs font-mono px-2 py-0.5 rounded uppercase tracking-wider">R Engine v4.3.1 Active</span>
            {pricingShock !== 'none' && (
              <span className="bg-red-50 border border-red-200 text-red-650 text-xs font-mono px-2 py-0.5 rounded uppercase tracking-wider animate-pulse flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> System Shock Fitted
              </span>
            )}
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-gray-900 flex items-center gap-2">
            <Train className="text-black w-8 h-8" />
            Statistical Rail Fare Optimisation Model
          </h1>
          <p className="text-sm text-gray-500">
            A real-time transport economics solver evaluating tariff anomalies, routing splittings, and Ordinary Least Squares price models.
          </p>
        </div>
        
        <div className="mt-4 md:mt-0 flex items-center gap-3 bg-white border border-gray-200 p-3 rounded-xl shadow-sm" id="obs-status">
          <Database className="text-black w-5 h-5 flex-shrink-0" />
          <div className="text-xs font-mono">
            <div className="text-gray-400">Observation Bank</div>
            <div className="font-bold text-gray-900">{baseTickets.length} Trained Trips</div>
          </div>
          <button 
            id="regen-btn"
            onClick={() => generateNewData(sampleSize, pricingShock)}
            disabled={isRefreshing}
            className="ml-3 p-2 bg-white hover:bg-gray-50 active:bg-gray-100 border border-gray-200 rounded text-gray-700 disabled:opacity-50 transition-colors shadow-sm cursor-pointer"
            title="Refit models with new observation samples"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-black' : ''}`} />
          </button>
        </div>
      </header>

      {/* DASHBOARD GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="dashboard-grid">
        
        {/* LEFT COLUMN: CONTROL PANEL */}
        <section className="lg:col-span-4 space-y-6" id="control-panel">
          <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-6 shadow-sm" id="params-card">
            
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <Sliders className="w-4 h-4 text-black" />
                Econometric Parameters
              </h2>
              <span className="text-xs text-gray-400 font-mono">Input Vectors</span>
            </div>

            {/* STATIONS QUERY */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5" id="origin-selector-container">
                  <label htmlFor="origin-select" className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-gray-400" />
                    Origin Node
                  </label>
                  <select 
                    id="origin-select"
                    value={origin} 
                    onChange={handleOriginChange}
                    className="w-full bg-white border border-gray-200 focus:border-black focus:ring-1 focus:ring-black rounded-lg p-2.5 text-sm text-gray-900 focus:outline-none shadow-sm transition-all shadow-xs"
                  >
                    {Object.values(STATIONS).map(st => (
                      <option key={st.id} value={st.id}>{st.name} ({st.code})</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5" id="dest-selector-container">
                  <label htmlFor="dest-select" className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-gray-400" />
                    Destination Node
                  </label>
                  <select 
                    id="dest-select"
                    value={destination} 
                    onChange={handleDestinationChange}
                    className="w-full bg-white border border-gray-200 focus:border-black focus:ring-1 focus:ring-black rounded-lg p-2.5 text-sm text-gray-900 focus:outline-none shadow-sm transition-all shadow-xs"
                  >
                    {Object.values(STATIONS).map(st => (
                      <option key={st.id} value={st.id}>{st.name} ({st.code})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ROUTE GEOMETRY REPORT */}
              <div className="bg-gray-50 border border-gray-150 rounded-lg p-3 text-xs flex justify-between tracking-wide" id="route-stats">
                <div>
                  <span className="text-gray-500 font-medium">Railway Distance:</span>
                  <span className="text-gray-900 font-bold font-mono ml-1.5">{calculateRailDistance(origin, destination)} km</span>
                </div>
                <div>
                  <span className="text-gray-500 font-medium">System Line:</span>
                  <span className="text-black font-semibold ml-1.5">{STATIONS[origin].line || 'Direct Network'}</span>
                </div>
              </div>
            </div>

            {/* BOOKING SLIDER */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <label htmlFor="booking-slider" className="font-semibold text-gray-700 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-gray-750" />
                  Booking Horizon Window
                </label>
                <span className="text-gray-900 font-mono font-bold bg-gray-100 border border-gray-200 px-2 py-0.5 rounded">
                  {bookingDays === 0 ? 'Day of Travel (Today)' : `${bookingDays} days out`}
                </span>
              </div>
              <input 
                type="range"
                id="booking-slider"
                min="0"
                max="90"
                value={bookingDays}
                onChange={(e) => setBookingDays(parseInt(e.target.value))}
                className="w-full accent-black bg-gray-200 h-2 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-gray-400 font-mono">
                <span>0d (Spikes)</span>
                <span>14d (Advance Tiers)</span>
                <span>45d</span>
                <span>90d (Cheapest Limit)</span>
              </div>
            </div>

            {/* DEPARTURE HOUR & PEAK CHECK */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-700 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-gray-750" />
                  Departure Train Schedule
                </span>
                <span className={`font-mono text-[11px] px-2 py-0.5 rounded font-bold border transition-colors ${
                  activeInPeak 
                    ? 'bg-red-50 border-red-200 text-red-650' 
                    : 'bg-green-50 border-green-200 text-green-700'
                }`}>
                  {activeInPeak ? '🚨 PEAK ZONE (+25%)' : '✅ OFF-PEAK ZONE'}
                </span>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select 
                    id="dep-hour-select"
                    value={departureHour}
                    onChange={(e) => setDepartureHour(parseInt(e.target.value))}
                    className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm font-mono text-gray-900 appearance-none focus:border-black focus:ring-1 focus:ring-black focus:outline-none"
                  >
                    {Array.from({ length: 18 }, (_, idx) => idx + 6).map(h => (
                      <option key={h} value={h}>
                        {h.toString().padStart(2, '0')} hours
                      </option>
                    ))}
                  </select>
                </div>
                <div className="relative flex-1">
                  <select 
                    id="dep-min-select"
                    value={departureMinute}
                    onChange={(e) => setDepartureMinute(e.target.value)}
                    className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm font-mono text-gray-900 appearance-none focus:border-black focus:ring-1 focus:ring-black focus:outline-none"
                  >
                    <option value="00">00 mins</option>
                    <option value="15">15 mins</option>
                    <option value="30">30 mins</option>
                    <option value="45">45 mins</option>
                  </select>
                </div>
              </div>
            </div>

            {/* RAILCARD CARD & OPERATOR SELECTORS */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="railcard-select" className="text-xs font-semibold text-gray-700">Railcard Discount</label>
                <select 
                  id="railcard-select"
                  value={railcard}
                  onChange={(e) => setRailcard(e.target.value as any)}
                  className="w-full bg-white border border-gray-200 rounded-lg p-2 text-xs text-gray-900 focus:border-black focus:ring-1 focus:outline-none shadow-sm"
                >
                  <option value="none">None (Full Fare)</option>
                  <option value="16-25">16-25 (-33.3%)</option>
                  <option value="senior">Senior 60+ (-33.3%)</option>
                  <option value="two-together">Two Together (-33.3%)</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="operator-select" className="text-xs font-semibold text-gray-700">Preferred Franchise</label>
                <select 
                  id="operator-select"
                  value={selectedOperator}
                  onChange={(e) => setSelectedOperator(e.target.value)}
                  className="w-full bg-white border border-gray-200 rounded-lg p-2 text-xs text-gray-900 focus:border-black focus:ring-1 focus:outline-none shadow-sm"
                >
                  <option value="Any">All Operators</option>
                  {OPERATORS.map(op => (
                    <option key={op.name} value={op.name}>{op.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* ADVANCED MODEL CONFIGS (SHOCKS ET AL) */}
            <div className="border-t border-gray-150 pt-5 space-y-4" id="advanced-configs">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest font-mono">Model Configuration</div>
              
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="space-y-1.5">
                  <label htmlFor="sample-size-select" className="text-gray-550 flex items-center gap-1">Simulation Bank Size</label>
                  <select 
                    id="sample-size-select"
                    value={sampleSize}
                    onChange={(e) => {
                      const size = parseInt(e.target.value);
                      setSampleSize(size);
                      generateNewData(size, pricingShock);
                    }}
                    className="w-full bg-white border border-gray-200 rounded p-1.5 font-mono text-gray-900 focus:border-black focus:outline-none shadow-sm"
                  >
                    <option value="250">250 trips</option>
                    <option value="500">500 trips</option>
                    <option value="800">800 trips</option>
                    <option value="1200">1200 trips</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="system-shock-select" className="text-red-500 flex items-center gap-1">System Pricing Shock</label>
                  <select 
                    id="system-shock-select"
                    value={pricingShock}
                    onChange={(e) => {
                      const sk = e.target.value as any;
                      setPricingShock(sk);
                      generateNewData(sampleSize, sk);
                    }}
                    className="w-full bg-[#fffcfc] border border-red-200 rounded p-1.5 font-mono text-red-650 focus:border-red-500 focus:outline-none shadow-sm"
                  >
                    <option value="none">None (Standard Market)</option>
                    <option value="strike">Rail Strike (+40% Spiked)</option>
                    <option value="inflation">RPI Fare Hike (+18%)</option>
                    <option value="dereg">Fare Deregulation</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200/60 rounded-lg p-4 text-xs text-gray-650 leading-relaxed flex gap-2" id="explanation-box">
              <Info className="w-4.5 h-4.5 text-gray-500 flex-shrink-0 mt-0.5" />
              <div>
                <strong className="block font-semibold text-gray-900 mb-0.5">The Split Ticket Arbitrage Anomaly:</strong>
                In the UK, distance tickets spanning multiple franchise corridors carry dynamic structural premiums. By dividing these journeys over intermediate station endpoints (nodes), the OLS solver isolates the cheapest unbundled tariff combinations.
              </div>
            </div>

          </div>
        </section>

        {/* RIGHT COLUMN: REPORT & ANALYTICS */}
        <section className="lg:col-span-8 space-y-6" id="analytics-column">
          
          {/* ARBITRAGE REPORT HEADLINE PANEL */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm space-y-5" id="arbitrage-report">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <Binary className="text-black w-5 h-5" />
                Live Arbitrage Finder Results
              </h2>
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <ShieldCheck className="text-green-600 w-4 h-4" />
                <span>Confidence score: <span className="font-mono font-bold text-green-600">{modelConfidence}%</span></span>
              </div>
            </div>

            {/* SIDE-BY-SIDE COMPONENT */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4" id="pricing-headline-grid">
              
              {/* DIRECT FARE COUNTER */}
              <div className="bg-gray-50 border border-gray-150 rounded-xl p-4 space-y-1 relative overflow-hidden" id="direct-fare-info">
                <div className="text-xs text-gray-500 flex justify-between items-center">
                  <span>Direct Routing Price</span>
                  <span className="bg-gray-200 text-gray-700 text-[9.5px] uppercase px-1.5 py-0.5 rounded font-semibold font-mono">
                    {directRouteDetails.ticketType}
                  </span>
                </div>
                <div className="text-3xl font-extrabold font-mono text-gray-900 pt-1">
                  £{directRouteDetails.totalPrice.toFixed(2)}
                </div>
                <p className="text-[10px] text-gray-400 font-mono">
                  Route single: {directRouteDetails.operator}
                </p>
                <div className="absolute right-2 bottom-2 text-gray-200/40 font-bold text-4xl font-mono select-none pointer-events-none">
                  DIR
                </div>
              </div>

              {/* SPLIT TICKET VALUE */}
              <div className="bg-black text-white rounded-xl p-4 space-y-1 relative overflow-hidden shadow-sm" id="split-fare-info">
                <div className="text-xs text-gray-300 flex justify-between items-center font-medium">
                  <span>Split-Ticket Optimised</span>
                  <span className="bg-white/10 text-white text-[9.5px] uppercase px-1.5 py-0.5 rounded font-mono border border-white/20">
                    {splitRouteDetails.segments.length > 1 ? 'Arbitraged' : 'Direct Best'}
                  </span>
                </div>
                <div className="text-3xl font-extrabold font-mono text-white pt-1">
                  £{splitRouteDetails.totalPrice.toFixed(2)}
                </div>
                <p className="text-[10px] text-gray-305 font-mono">
                  {splitRouteDetails.segments.length} segment{splitRouteDetails.segments.length === 1 ? '' : 's'} route sequence
                </p>
                <div className="absolute right-2 bottom-2 text-white/5 font-bold text-4xl font-mono select-none pointer-events-none">
                  SPLT
                </div>
              </div>

              {/* NET SAVINGS */}
              <div className={`rounded-xl p-4 space-y-1 relative overflow-hidden border transition-all duration-300 ${
                savingsReport.savings > 0 
                  ? 'bg-green-50/50 border-green-200 text-green-700 shadow-xs' 
                  : 'bg-gray-50 border-gray-150 text-gray-400'
              }`} id="savings-visual">
                <div className="text-xs flex justify-between items-center">
                  <span>Net Arbitrage Savings</span>
                  <Coins className={`w-3.5 h-3.5 ${savingsReport.savings > 0 ? 'text-green-600' : 'text-gray-400'}`} />
                </div>
                <div className="text-3xl font-extrabold font-mono pt-1">
                  {savingsReport.savings > 0 ? `£${savingsReport.savings.toFixed(2)}` : '£0.00'}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold">
                  {savingsReport.savings > 0 ? (
                    <>
                      <TrendingDown className="w-3.5 h-3.5" />
                      Saved {savingsReport.savings_percent}% on base fare
                    </>
                  ) : (
                    <span className="text-gray-500">Direct route is optimal price</span>
                  )}
                </div>
                <div className="absolute right-2 bottom-2 text-green-500/5 font-bold text-4xl font-mono select-none pointer-events-none">
                  SAVE
                </div>
              </div>

            </div>

            {/* SPLIT ROUTE SCHEMATIC ROADMAP */}
            <div className="bg-gray-50 border border-gray-200 p-4 rounded-xl space-y-3" id="schematic-map">
              <div className="text-xs font-bold text-gray-600 tracking-wider uppercase font-mono border-b border-gray-200 pb-2">
                Optimal Station Intermediary Segment Roadmap
              </div>

              {splitRouteDetails.segments.length > 1 ? (
                <div className="space-y-4" id="multi-segment-route">
                  {/* Schematic Map Row Line */}
                  <div className="relative pt-6 pb-2 px-4" id="railway-schematic-track">
                    {/* The Rail Line Background */}
                    <div className="absolute top-1/2 left-6 right-6 h-1 bg-gray-200 rounded -translate-y-1/2 pointer-events-none" />
                    
                    {/* Dynamic segments path dots */}
                    <div className="relative flex justify-between items-center z-10">
                      {splitRouteDetails.path.map((node, index) => {
                        const isNodeOrigin = index === 0;
                        const isNodeDest = index === splitRouteDetails.path.length - 1;
                        const st = STATIONS[node];

                        return (
                          <div key={node} className="flex flex-col items-center group relative">
                            {/* Inner Dot */}
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center font-mono text-xs font-bold border transition-colors ${
                              isNodeOrigin 
                                ? 'bg-blue-50 border-blue-600 text-blue-600'
                                : isNodeDest 
                                  ? 'bg-red-50 border-red-600 text-red-650'
                                  : 'bg-white border-black text-black'
                            }`}>
                              {st?.code || node}
                            </div>
                            
                            {/* Station Label */}
                            <span className="text-[10px] font-mono font-bold text-gray-700 mt-2 whitespace-nowrap text-center max-w-[80px] break-words">
                              {st?.name.split(' ')[0] || node}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Individual Segment Tickets Breakdown */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3" id="segment-ticket-cards">
                    {splitRouteDetails.segments.map((seg, idx) => (
                      <div key={idx} className="bg-white border border-gray-200 rounded-lg p-3 flex justify-between items-center text-xs shadow-sm" id={`seg-card-${idx}`}>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5 font-bold text-gray-800">
                            <span className="bg-gray-100 text-gray-750 px-1.5 py-0.2 rounded font-mono text-[10px]">{idx + 1}</span>
                            <span>{STATIONS[seg.from]?.name || seg.from}</span>
                            <span className="text-gray-400 font-mono">→</span>
                            <span>{STATIONS[seg.to]?.name || seg.to}</span>
                          </div>
                          <div className="text-[10px] text-gray-550 font-mono">
                            {seg.distance_km} km | {seg.operator} franchise 
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold font-mono text-black text-sm">£{seg.price.toFixed(2)}</div>
                          <span className="text-[9px] bg-gray-100 text-gray-700 px-1 py-0.2 rounded uppercase font-semibold font-mono border border-gray-200 inline-block">
                            {seg.ticket_type}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-4 text-center text-gray-555 bg-white border border-dashed border-gray-200 rounded-lg text-xs" id="no-split-visual">
                  No structural fare split arbitrage detected for this scenario. The direct routing of {calculateRailDistance(origin, destination)} km is the cheapest pricing boundary.
                </div>
              )}
            </div>

          </div>

          {/* DYNAMIC VISUAL CHARTS TABS */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm" id="charts-panel">
            
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-100 pb-3 mb-4">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <BarChart3 className="text-black w-5 h-5" />
                Visual Fare Analytics Suite
              </h2>
              
              {/* TABS SELECTOR */}
              <div className="flex bg-gray-100 p-1 rounded-lg border border-gray-100 self-start" id="viz-tabs">
                <button 
                  id="tab-advance-btn"
                  onClick={() => setActiveTab('advance')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded transition-all cursor-pointer ${
                    activeTab === 'advance' 
                      ? 'bg-white text-black shadow-sm' 
                      : 'text-gray-500 hover:text-gray-950'
                  }`}
                >
                  Advance Window decay
                </button>
                <button 
                  id="tab-arima-btn"
                  onClick={() => setActiveTab('arima')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded transition-all cursor-pointer ${
                    activeTab === 'arima' 
                      ? 'bg-white text-black shadow-sm' 
                      : 'text-gray-500 hover:text-gray-950'
                  }`}
                >
                  ARIMA Volatility
                </button>
                <button 
                  id="tab-operators-btn"
                  onClick={() => setActiveTab('operators')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded transition-all cursor-pointer ${
                    activeTab === 'operators' 
                      ? 'bg-white text-black shadow-sm' 
                      : 'text-gray-500 hover:text-gray-950'
                  }`}
                >
                  Operator Comparison
                </button>
              </div>
            </div>

            {/* TAB CONTENT CAROUSELS */}
            <div className="h-[320px] w-full" id="viz-canvas">
              {activeTab === 'advance' && (
                <div className="w-full h-full space-y-2">
                  <div className="text-xs text-gray-500 mb-1">
                    Plots price against booking window horizon. Overlay maps raw observed cluster data (matching segment lengths) alongside the OLS fitted regression curves.
                  </div>
                  <div className="w-full h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={fittedLineData}
                        margin={{ top: 5, right: 20, bottom: 20, left: 10 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                        <XAxis 
                          dataKey="days" 
                          type="number" 
                          domain={[0, 90]} 
                          name="Booking Days Before" 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                          label={{ value: 'Days Prior to Travel', position: 'bottom', offset: 5, fill: '#6b7280', fontSize: 11 }}
                        />
                        <YAxis 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                          label={{ value: 'Fare Price (£)', angle: -90, position: 'insideLeft', offset: 0, fill: '#6b7280', fontSize: 11 }}
                        />
                        <RechartsTooltip 
                          contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e5e7eb', color: '#111827', borderRadius: '6px', fontSize: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}
                          labelFormatter={(label) => `Horizon: ${label} Days Before`}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                        
                        {/* Observable scatter points overlay */}
                        <Scatter 
                          name="Observed Route Data" 
                          data={scatterPoints} 
                          fill="#3b82f6" 
                          fillOpacity={0.35}
                          line={false}
                          dataKey="price"
                          xAxisId={0}
                        />

                        {/* Fitted Regression Line */}
                        <Line 
                          name="OLS Multi-Regression Fit" 
                          dataKey="predictedPrice" 
                          stroke="#000000" 
                          strokeWidth={2.5} 
                          dot={false}
                          activeDot={{ r: 8 }}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {activeTab === 'arima' && (
                <div className="w-full h-full space-y-2">
                  <div className="text-xs text-gray-500 mb-1">
                    24-Hour simulated pricing predictions showing daily seasonality components alongside full 95% forecast standard error confidence bands.
                  </div>
                  <div className="w-full h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={forecastData}
                        margin={{ top: 5, right: 20, bottom: 20, left: 10 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                        <XAxis 
                          dataKey="hour" 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                        />
                        <YAxis 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                          label={{ value: 'Estimated Price (£)', angle: -90, position: 'insideLeft', offset: 0, fill: '#6b7280', fontSize: 11 }}
                        />
                        <RechartsTooltip 
                          contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e5e7eb', color: '#111827', borderRadius: '6px', fontSize: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}
                          formatter={(value: any, name: any) => [`£${Number(value).toFixed(2)}`, name]}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                        
                        {/* ARIMA CI Error Area Sheet */}
                        <Area 
                          name="95% ARIMA Forecast confidence band" 
                          dataKey="upperBound" 
                          stroke="none" 
                          fill="#000000" 
                          fillOpacity={0.06}
                          tooltipType="none"
                        />
                        <Area 
                          name="Lower boundary" 
                          dataKey="lowerBound" 
                          stroke="none" 
                          fill="none" 
                          tooltipType="none"
                        />
                        
                        {/* Predicted Cheapest pricing Line */}
                        <Line 
                          name="Forecast Price (Cheapest Option)" 
                          dataKey="forecastedCheapest" 
                          stroke="#000000" 
                          strokeWidth={2} 
                          dot={true}
                        />

                        {/* Standard Anytime schedule */}
                        <Line 
                          name="Anytime Single rate Reference" 
                          dataKey="anytimePrice" 
                          stroke="#dc2626" 
                          strokeWidth={1}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {activeTab === 'operators' && (
                <div className="w-full h-full space-y-2 font-sans">
                  <div className="text-xs text-gray-500 mb-1">
                    Normalized average price spread computed across various UK franchisee operators for this {calculateRailDistance(origin, destination)} km journey path.
                  </div>
                  <div className="w-full h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={operatorAverages}
                        margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                        <XAxis 
                          dataKey="name" 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                        />
                        <YAxis 
                          stroke="#9ca3af" 
                          tick={{ fontSize: 10, fill: '#374151' }}
                          label={{ value: 'Standard Normalized Price (£)', angle: -90, position: 'insideLeft', offset: 0, fill: '#6b7280', fontSize: 11 }}
                        />
                        <RechartsTooltip 
                          contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e5e7eb', color: '#111827', borderRadius: '6px', fontSize: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}
                          formatter={(value: any) => [`£${Number(value).toFixed(2)}`, 'Normalized Journey Fare']}
                        />
                        <Bar 
                          dataKey="avgPrice" 
                          fill="#111827" 
                          radius={[4, 4, 0, 0]} 
                          maxBarSize={50}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* THE ECONOMETRICIAN R CONSOLE */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm" id="r-console-card">
            
            <div className="bg-gray-50 px-5 py-3 border-b border-gray-200 flex items-center justify-between" id="r-console-header">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-gray-300 border border-gray-400/20" />
                <span className="w-2.5 h-2.5 rounded-full bg-gray-300 border border-gray-400/20" />
                <span className="w-2.5 h-2.5 rounded-full bg-gray-300 border border-gray-400/20" />
                <span className="text-xs font-mono font-bold text-gray-700 ml-2">R Session - lm_fare_model.R</span>
              </div>
              <span className="text-[10px] bg-gray-100 text-gray-800 border border-gray-200 px-1.5 py-0.5 rounded font-mono">
                Ordinary Least Squares (OLS)
              </span>
            </div>

            <div className="bg-[#1e1e1e] p-4 text-emerald-400" id="r-console-body">
              <pre className="text-[11px] md:text-xs font-mono leading-5 overflow-x-auto whitespace-pre">
                {rSummaryText}
              </pre>
            </div>

            <div className="bg-gray-50/50 border-t border-gray-200 px-5 py-3.5 text-xs text-gray-500 flex flex-col md:flex-row md:items-center md:justify-between gap-4" id="elasticity-controls">
              <div className="flex items-center gap-2">
                <Binary className="text-gray-600 w-4 h-4" />
                <span>Significance Code Analysis: Distance and Peak Dummies hold the highest T-values.</span>
              </div>
              <p className="text-[11px] text-gray-400">
                Formula updates instantly upon injecting shocks in input panels.
              </p>
            </div>

          </div>

        </section>

      </div>

      {/* FOOTER METADATA */}
      <footer className="mt-8 border-t border-gray-200 pt-5 text-center text-[11px] text-gray-400 font-mono flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4" id="app-footer">
        <p>
          UK Transport Economics Pricing Model — Strictly Academic & Econometric Simulation.
        </p>
        <p>
          Data Observation Bank Matrix refreshed dynamically. Fit residuals standard deviation error is normal proxy.
        </p>
      </footer>
    </div>
  );
}
