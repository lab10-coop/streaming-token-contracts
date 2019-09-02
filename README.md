## About

This repository contains example implementations of the **Streaming Token Standard** proposed in [EIP-2100](https://github.com/ethereum/EIPs/issues/2100).

## Background

Since ever, money and money-like assets have been transferred atomically. We’re so used to it that – even though terms such as _cashflow_ exist, we hardly ever question that limitation.  
The idea of modelling monetary streams as actual flows is however not new. My favourite historical example is the [MONIAC](https://en.wikipedia.org/wiki/MONIAC) (Monetary National Income Analogue Computer), built more than 50 years ago by an economist in order to model the national economic processes of the UK. Check out [this video](https://www.sms.cam.ac.uk/media/1094078) for a detailed demonstration.

![A Moniac Computer exhibited in New Zealand](https://www.rnz.co.nz/assets/news/31461/eight_col_T7620-rbnz-WEB.jpg?1421270318)

At the time of the Moniac, technology was not ready to build systems which allow to have such continuous transfers in the real world.  
The closest we got to that are probably pipelines transferring oil and gas, but those aren't the kind of assets we typically use for money-type transactions. 

After listening to Andreas Antonopolous [talking about Streaming Money](https://www.youtube.com/watch?v=l235ydAx5oQ), the idea that this could be implemented in an elegant way on Ethereum got stuck in my head.  
[First implementation attempts](https://github.com/lab10-coop/streem-poc) showed that this was a challenging, but possible task, and that it should be possible to implement this as an extension to an ERC20 compliant token.  
Over time, the idea was shared with people around me and eventually also [presented at SWARM Orange Summit 2018](https://www.youtube.com/watch?v=4C_Djl78dqM).  
The idea met a lot of interest, but it also proved to be difficult to explain, because the concept of continuous money-like transfers which don't rely on _some_ kind of settlements - as in payment channel based micro-transactions - seems to be hard to grasp.  

Thus we at lab10 focused on building a bit more than raw contracts in order to allow for a more intuitive understanding, based on interaction with Streaming Tokens (TODO: add links):
* A web wallet which supports atomic and continuous transfers
* A Hackathon project which uses Streaming Tokens for operating an oldschool music player ([blog article](https://medium.com/lab10-collective/lab10-wins-infineon-blockchain-hackathon-and-streams-music-over-artis-mainnet-5fff84ffd140))
* A demonstration for a research project where Streaming Tokens are used to pay for charging of an electric car

We also thought about how to add streaming functionality to existing assets.  
In 2018 we even started to modify the Parity implementation of the Ethereum protocol such that the blockchain native token would be streamable, to be used for the ARTIS blockchain.  
That attempt was abandoned, because the utility of a streamable native token was not so clear (compared to e.g. the utility of stable tokens) and because adding that level of complexity at the core protocol level turned out to be something we didn't feel comfortable doing with the resources at hand.   

Instead we figured out that token bridges were a great opportunity for adding streaming functionality to tokens. (TODO: publish and link)  
This allows token bridges to sidechains to add streaming functionality to any bridged token (or even to ETH).

## Simple Streaming Token

Contract code in `contracts/SimpleStreamingToken.sol`  
Tests in `SimpleStreamingToken.js`

This implementation is based on the [first PoC](https://github.com/lab10-coop/streem-poc), but updated for Solidity v5 and adapted to the proposed interface.  
It allows any account to open a stream to any other account. Main limitation: only one sending and one receiving stream per account allowed.    
For more details, look into the contract source file. 

## Basic Streaming Token

Contract code in `contracts/BasicStreamingToken.sol`  
Tests in `BasicStreamingToken.js`

This implements a set of restrictions we came up with after many conversations about how to deal with the challenge of possible infinite recursions.  
It starts from the premise that continuous transfers are usually needed for subscription-type relations and that subscriptions typically involve many-to one relations - meaning that somebody offering a subscription service may want to have a receiver account which can receive many streaming transfers at the same time, but doesn't necessarily need outgoing streams.  
The design implies that a newly deployed instances of such a token contract don't allow any streams to be opened at all. At least one account needs to be set as having a non-default `account type` beforehand by its owner invoking the method `setAccountType`.     
This represents an example for an interface extended by implementation specific methods.
  
This is the kind of implementation we are using for Streaming Bridged Tokens on ARTIS (TODO: link).

## Running

Requires node v10.

Install with `npm install`.  
Run tests with `npm test`.
