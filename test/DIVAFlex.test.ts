import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  mine,
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  DIVAFlex,
  BinaryPositionsFactory,
  BinaryImplementation,
  MockERC20,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DIVAFlex", function () {
  // Types
  interface SetupOutput {
    divaFlex: DIVAFlex;
    owner: SignerWithAddress;
    acc2: SignerWithAddress;
    acc3: SignerWithAddress;
    oracle: SignerWithAddress;
    mockToken: MockERC20;
    mockTokenDecimals: number;
    binaryPositionsFactory: BinaryPositionsFactory;
    binaryImplementation: BinaryImplementation;
    createMarketParams: {
      positionContract: string;
      oracle: string;
      stakingPeriod: bigint;
      observationPeriod: bigint;
      stakeToken: string;
      creatorFee: bigint;
      feeRecipient: string;
      referenceEvent: string;
    };
  }

  // Test setup function
  async function setup(): Promise<SetupOutput> {
    // Get signers
    const [owner, acc2, acc3, oracle] = await ethers.getSigners();

    // Deploy mock token
    const mockTokenDecimals = 18;
    const mockToken = await ethers.deployContract("MockERC20", [
      "Mock Token",
      "MT",
      ethers.parseUnits("1000000", mockTokenDecimals), // 1M tokens
      owner.address,
      mockTokenDecimals,
      0, // no fee
    ]);
    await mockToken.waitForDeployment();

    // Deploy BinaryPositionsFactory and get implementation
    const binaryPositionsFactory = await ethers.deployContract(
      "BinaryPositionsFactory",
    );
    await binaryPositionsFactory.waitForDeployment();

    const binaryImplementationAddress =
      await binaryPositionsFactory.getBinaryPositionsImplementation();
    const binaryImplementation = await ethers.getContractAt(
      "BinaryImplementation",
      binaryImplementationAddress,
    );

    // Create binary positions with 2 positions
    await binaryPositionsFactory.createBinaryPositions(2);
    const binaryPositionsAddress =
      await binaryPositionsFactory.getPositionContractAddress(2);

    // Deploy DIVAFlex
    const divaFlex = await ethers.deployContract("DIVAFlex", [owner.address]);
    await divaFlex.waitForDeployment();

    // Default create market parameters
    const createMarketParams = {
      positionContract: binaryPositionsAddress,
      oracle: oracle.address,
      stakingPeriod: BigInt(24 * 60 * 60), // 1 day
      observationPeriod: BigInt(24 * 60 * 60), // 1 day
      stakeToken: await mockToken.getAddress(),
      creatorFee: BigInt(100), // 1%
      feeRecipient: owner.address,
      referenceEvent: "BTC/USD > 50000",
    };

    // Transfer some tokens to acc2 and acc3 for testing
    await mockToken.transfer(
      acc2.address,
      ethers.parseUnits("10000", mockTokenDecimals),
    );
    await mockToken.transfer(
      acc3.address,
      ethers.parseUnits("10000", mockTokenDecimals),
    );

    return {
      divaFlex,
      owner,
      acc2,
      acc3,
      oracle,
      mockToken,
      mockTokenDecimals,
      binaryPositionsFactory,
      binaryImplementation,
      createMarketParams,
    };
  }

  describe("Constructor", function () {
    let s: SetupOutput;

    beforeEach(async () => {
      s = await loadFixture(setup);
    });

    it("Should set the owner correctly", async () => {
      expect(await s.divaFlex.owner()).to.equal(s.owner.address);
    });
  });

  // Additional test sections will go here, following the same pattern as the example
  // describe("createMarket", function () {...})
  // describe("stake", function () {...})
  // etc.
});
