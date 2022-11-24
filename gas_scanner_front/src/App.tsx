import React from 'react';
import ReactDOM from 'react-dom';
// @ts-ignore
import {GasChart} from "./components/GasChart";
import "./App.css";
import { useEffect, useState } from "react"
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import {BlockListComponent} from "./components/BlockList";
// @ts-ignore
import {BlockListProvider} from "./provider/BlockListProvider";
// @ts-ignore
import {GasChartAverage} from "./components/GasChartAverage";
// @ts-ignore
import {GasChartAverageTimeFrame} from "./components/GasChartTimeFrame";
import {Button, Flex, Heading, Link as ChakraLink, Spacer} from "@chakra-ui/react";
import {Link, useNavigate} from "react-router-dom";
import {SuggestedGasComponent} from "./components/GasPrices";
import {AddressListComponent} from "./components/AddressList";


ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend
);

export const options = {
  responsive: true,
  plugins: {
    legend: {
      position: 'top',
    },
    title: {
      display: true,
      text: 'GasChart.tsx Bar Chart',
    },
  },
};

const defaultData =
  [
  ];

class AppProps {
    page: string = "";
}

class AppState {
    seconds: number = 0;
    blockListProvider = new BlockListProvider();
    page: string = "";
}

export class App extends React.Component<AppProps> {
  // @ts-ignore
    constructor(props : AppProps) {
        super(props);
    this.state = {
      seconds: 0,
      blockListProvider: new BlockListProvider(),
      page: props.page
    };
  }

  state: AppState;

  componentDidMount() {
   // this.interval = setInterval(async () => await this.tick(), 2000);
  }

  componentWillUnmount() {
    //clearInterval(this.interval);
  }

    goToMain() {
        this.setState({
            seconds: this.state.seconds,
            blockListProvider: this.state.blockListProvider,
            page: "main"
        })
    }

  goToAbout() {
      this.setState({
          seconds: this.state.seconds,
          blockListProvider: this.state.blockListProvider,
          page: "about"
      })
  }

  render() {
    return (
        <Flex direction="column" padding="0px 20px" height="100%">
          <Flex height="100px;" padding="10px">
              <Flex align="center">
                  <Heading>PolygonGas</Heading>
              </Flex>
              <Flex align="center" padding="0 20px" gridGap="3">
                  <Button onClick={this.goToMain.bind(this)}>Main</Button>
                  <Button onClick={this.goToAbout.bind(this)}>About</Button>
              </Flex>

              <Flex align="center" direction="column" padding="20px">
                  <Flex>Sponsored by: </Flex>
                  <Flex><ChakraLink href="https://golem.network">golem.network</ChakraLink></Flex>
              </Flex>

          </Flex>
            {this.state.page == "main" &&
              <Flex direction="column" shrink="0">
                <Flex direction="row" flex={1} shrink="0" alignItems="stretch" justifyContent="space-between"
                      gridGap="5">
                  <Flex direction="column">
                    <SuggestedGasComponent></SuggestedGasComponent>
                    <AddressListComponent></AddressListComponent>
                    <BlockListComponent></BlockListComponent>
                  </Flex>
                  <GasChart></GasChart>
                  <Flex>&nbsp;</Flex>
                </Flex>
              </Flex>
            }
            {this.state.page == "about" &&
              <Flex direction="column" shrink="0">
                About
              </Flex>
            }

        </Flex>
    );
  }
}
