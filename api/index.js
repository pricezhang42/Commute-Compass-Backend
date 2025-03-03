const axios = require('axios');
const cors = require('cors');
const express = require('express');
const app = express();
const port = 3000;
require('dotenv').config();

app.use(express.json()); // Middleware to parse JSON bodies
// const corsOptions ={
//     origin:'*', 
//     credentials:true,            //access-control-allow-credentials:true
//     optionSuccessStatus:200,
//  }
 
app.use(cors()); // Use this after the variable declaration

app.post('/myFunction', async (req, res) => {
    console.log(req.body);
    const origin = req.body.coordOrigin;
    const destination = req.body.coordDest;
    const result = await main(origin, destination);
    console.log("---------------------");
    console.log(result);
    res.send(JSON.stringify(result));
});

app.get('/', function (req, res) {
    console.log("Trigger?");
	res.send("Something");
});

const autocompleteAPI = 'https://winnipegtransit.com/api/v2/navigo/autocomplete';
const tripPlannerAPI = 'https://api.winnipegtransit.com/v3/trip-planner.json';
const stopAPI = 'https://api.winnipegtransit.com/v3/stops/';
const apiKey = process.env.API_KEY;

const sendRequest = (url, config) => {
    return axios.get(url, config);
}

const getLocationHrefs = (origin, destination) => {
    const originAutocompPromise = sendRequest(autocompleteAPI, { params: { term: origin } });
    const destinationAutocompPromise = sendRequest(autocompleteAPI, { params: { term: destination } });

    return Promise.all([originAutocompPromise, destinationAutocompPromise])
        .then(responses => {
            return responses.map(response => response.data[0].href);
        })
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}

const getTripPlans = (originHref, destinationHref) => {
    return sendRequest(tripPlannerAPI, { params: { 'api-key': apiKey, origin: originHref, destination: destinationHref } })
        .then(response => {
            return response.data.plans;
        })
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}

const getTripPlansByGeo = (originGeo, destinationGeo) => {
    var originGeoFormated = `geo/${originGeo[0]},${originGeo[1]}`;
    var destinationGeoFormated = `geo/${destinationGeo[0]},${destinationGeo[1]}`;
    console.log(originGeoFormated);

    return sendRequest(tripPlannerAPI, { params: { 'api-key': apiKey, origin: originGeoFormated, destination: destinationGeoFormated } })
        .then(response => {
            return response.data.plans;
        })
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}

const getStopFeatures = (stopKey) => {
    return sendRequest(stopAPI + stopKey + '/features.json', { params: { 'api-key': apiKey } })
        .then(response => {
            return response.data['stop-features'];
        })
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}

// Function to check if a stop is sheltered
const isStopSheltered = async (stopKey) => {
    const features = await getStopFeatures(stopKey);
    for (const feature of features) {
        if (feature.name.includes('Shelter')) {
            return true;
        }
    }
    return false;
}

// Function to calculate route statistics
const calculateRouteStats = async (plan) => {
    let shelterDensity = 0;
    let totalDuration = plan.times.durations.total || 0;
    let totalTimeOutside = plan.times.durations.walking || 0;
    let numTransfers = 0;
    let numToStops = 0;
    let numShelteredToStops = 0;

    for (const seg of plan.segments) {
        // If the segment is a transfer or a walk to a stop, update the number of transfers and the time spent outside   
        if (seg.type === "transfer" || (seg.type === "walk" && seg.to?.stop)) {
            
            if(seg.type === "transfer") {
                numTransfers++;
            }

            numToStops++;

            const stopKey = seg.to.stop.key;
            const isSheltered = await isStopSheltered(stopKey);

            // If the stop is sheltered, update the number of sheltered stops, otherwise update the time spent outside if it exists
            if (isSheltered) {
                numShelteredToStops++;
                seg.to.stop["isSheltered"] = true;
            }
            else {
                if (seg.times.durations.waiting) {
                    totalTimeOutside += seg.times.durations.waiting;
                    seg.to.stop["isSheltered"] = false;
                }
            }
        }
    }

    // if there are no transfers, the shelterDensity is the maximum value of 1
    shelterDensity = numToStops > 0 ? (numShelteredToStops / numToStops) : 1;

    return {
        planId: plan.number,
        shelterDensity,
        totalDuration,
        totalTimeOutside,
        numTransfers
    };
}

const getPlans = async (origin, destination) => {
    // const hrefs = await getLocationHrefs(origin, destination);
    // const plans = await getTripPlans(hrefs[0], hrefs[1]);

    const plans = await getTripPlansByGeo(origin, destination);
    // console.log(plans);

    return plans;
}

const getRouteStats = async (plans) => {
    const routeStats = [];
    for (const plan of plans) {
        const routeStat = await calculateRouteStats(plan);
        routeStats.push(routeStat);
        // console.log('Stats', routeStat.planId, routeStat.shelterDensity, routeStat.totalDuration, routeStat.totalTimeOutside, routeStat.numTransfers);
    }

    return routeStats;
}

const normalizeRouteStats = (routeStats) => {
    const maxShelterDensity = Math.max(...routeStats.map(stat => stat.shelterDensity));
    const maxDuration = Math.max(...routeStats.map(stat => stat.totalDuration));
    const maxTimeOutside = Math.max(...routeStats.map(stat => stat.totalTimeOutside));
    const maxTransfers = Math.max(...routeStats.map(stat => stat.numTransfers));

    for (const stat of routeStats) {
        stat.shelterDensity = stat.shelterDensity / maxShelterDensity;
        stat.totalDuration = stat.totalDuration / maxDuration;
        stat["totalTimeOutsideUnnorm"] = stat.totalTimeOutside;
        stat.totalTimeOutside = stat.totalTimeOutside / maxTimeOutside;
        stat.numTransfers = stat.numTransfers / maxTransfers;
    }

    return routeStats;
}

const calculateRouteScores = (normalizedStats) => {
    const scores = [];

    for (const stat of normalizedStats) {
        const score = stat.shelterDensity + 2*(1 - stat.totalTimeOutside) + (1 - stat.totalDuration) + (1 - stat.numTransfers);
        scores.push({ planId: stat.planId, score: score, totalTimeOutside: stat.totalTimeOutsideUnnorm });
    }
    return scores;
}

const orderRouteScores = (routeScores) => {
    return routeScores.sort((a, b) => b.score - a.score);
}

const main = async (origin, destination) => {
    try {
        const plans = await getPlans(origin, destination);
        const routeStats = await getRouteStats(plans);
        const normalizedStats = normalizeRouteStats(routeStats);
        console.log('Normalized Stats', normalizedStats);
        const routeScores = calculateRouteScores(normalizedStats);
        const orderedRouteScores = orderRouteScores(routeScores);
        // console.log('Scores', orderedRouteScores);
        return [plans, orderedRouteScores];
    } catch (err) {
        console.error("Error fetching route data:", err);
        return [];
    }

}

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});

module.exports = app;
