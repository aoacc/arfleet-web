import config from './config';
// const { MINUTE } = require('../utils/constants');
// const axios = require('axios');
// const { getAoInstance } = require('./ao');
// const { color } = require('../utils/color');
import { MINUTE } from './constants';
import { getAoInstance } from './ao';

function color(x) {
    return x;
}

let passes = null;

const checkPasses = async(firstTime = false, ourAddress = null) => {
    console.log("Checking passes...");
    try {
        const passAddress = config.passes.address;
    
        const ao = getAoInstance();
        const response = await ao.dryRun(passAddress, "Info");

        const passesReturned = response.Balances;

        const passesDestringified = Object.fromEntries(
            Object.entries(passesReturned).map(([key, value]) => [key, Number(value)])
        );

        const passesFiltered = Object.fromEntries(
            Object.entries(passesDestringified).filter(([key, value]) => value > 0)
        );

        passes = passesFiltered;

        if (firstTime) {
            console.log(Object.keys(passes).length.toString() + " ArFleet:Genesis passes found");
            if (ourAddress) {
                if (await hasPass(ourAddress)) {
                    console.log(color("✅ You have an ArFleet:Genesis pass! 🎉", "green"));
                } else {
                    console.log("");
                    console.log(color("WARNING: You don't have an ArFleet:Genesis pass to participate in the testnet! 😢", "red"));
                    console.log("");
                    console.log(color("Providers/clients on testnet won't be able to connect to you without a valid pass.", "red"));
                    console.log("");
                    console.log(color("ArFleet:Genesis passes are this asset on Bazar: https://bazar.arweave.dev/#/asset/"+config.passes.address+"", "red"));
                    console.log("");
                    console.log(color("Send the pass to your address here: " + ourAddress, "red"));
                }
            }
        }

        // Success!
    } catch(e) {
        console.error(e);
    }
}

const getBazarProfiles = async (ownerAddress) => {
    const ao = getAoInstance();
    const query = `query {
        transactions(
            tags: [{name: "Data-Protocol", values: ["Permaweb-Zone"]}, {name: "Zone-Type", values: ["User"]}],
            owners: ["${ownerAddress}"],
            first: 100
        ) {
            edges {
                node {
                    id
                }
            }
        }
    }`;

    try {
        console.log(`Searching for bazar profiles for ${ownerAddress}`);
        const response = await ao.graphQL(query);

        if (response.data.transactions) {
            const edges = response.data.transactions.edges;
            if (edges && edges.length > 0) {
                const profiles = edges.map(edge => edge.node.id);
                console.log(`Found profiles: ${profiles.join(', ')}`);
                return profiles;
            }
        }
    } catch (e) {
        console.error("Failed to fetch bazar profiles", e.message);
    }
    return [];
}

const checkAddressForPass = async (address) => {
    const ao = getAoInstance();
    console.log(`Checking for pass on address: ${address}`);
    const passAddress = config.passes.address;
    
    try {
        const result = await ao.dryRun(passAddress, "Balance", JSON.stringify({
            "Target": address,
        }));
        
        // console.log('PASS CHECK', {address, result});
        const balance = result;

        if (typeof balance === 'number' && balance > 0) {
            console.log(`Pass found on ${address}`);
            return true;
        }
    } catch (e) {
        if (e.message.includes("Target does not have a balance")) {
            // This is an expected error when no pass is held, so we can ignore it.
        } else if (e.message.includes("No data returned from dry run")) {
            // This is also an expected error when no pass is held.
        }
        else {
            console.error(`Error checking pass for ${address}:`, e.message);
        }
    }
    return false;
}

const hasPass = async (address) => {
    const fromCache = passes && passes[address] && passes[address] > 0;
    if(fromCache) return true;

    return await hasPassLive(address);
}

const hasPassLive = async (address) => {
    console.log("Checking passes live for address:", address);

    if (await checkAddressForPass(address)) {
        return true;
    }

    console.log("Pass not found in wallet, checking Bazar profiles...");
    const profileAddresses = await getBazarProfiles(address);
    for (const profileAddress of profileAddresses) {
        if (await checkAddressForPass(profileAddress)) {
            return true;
        }
    }

    return false;
}

const startChecking = async(ourAddress = null) => {
    await checkPasses(true, ourAddress);

    // Leave default value here so it doesn't become 0 if unset
    // setInterval(checkPasses, config.fetchPassesInterval || 5 * MINUTE);
}

const getPasses = () => {
    return passes;
}

export {
    checkPasses,
    startChecking,
    getPasses,
    hasPass,
    hasPassLive
}